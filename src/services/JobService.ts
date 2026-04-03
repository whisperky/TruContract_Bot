import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ForumChannel,
  ThreadAutoArchiveDuration,
  type Client
} from "discord.js";

import type { AppConfig } from "../config.js";
import type {
  ApplicationOrigin,
  ApplicationRecord,
  FeedbackRecord,
  JobRecord,
  ProfileRecord,
  Tier
} from "../domain/models.js";
import { JsonStore } from "../storage/JsonStore.js";
import { formatExternalId, nowIso } from "../utils/id.js";
import { overlapScore, tokenize } from "../utils/text.js";
import { getEligibleAccountTiersForMarket, getTierLabel } from "../utils/tier.js";

export class JobService {
  readonly ACTIVE_APPLICATION_STATUSES = new Set<ApplicationRecord["status"]>(["submitted", "connected", "hired"]);

  constructor(
    private readonly client: Client,
    private readonly store: JsonStore,
    private readonly appConfig: AppConfig
  ) {}

  private readonly EMOJIS = {
    full: "<:star_full:1488689485720981534>",
    half: "<:star_half:1488689511104905216>",
    empty: "<:star_empty:1488689461893140480>"
  };

  async createJob(
    clientUserId: string,
    privateChannelId: string,
    marketTier: Tier,
    payload: {
      title: string;
      summary: string;
      skills: string[];
      budget: string;
      timeline: string;
    }
  ): Promise<JobRecord> {
    return this.store.mutate((draft) => {
      draft.counters.job += 1;
      const now = nowIso();
      const record: JobRecord = {
        id: formatExternalId("JOB", draft.counters.job),
        clientId: clientUserId,
        marketTier,
        title: payload.title,
        summary: payload.summary,
        skills: payload.skills,
        budget: payload.budget,
        timeline: payload.timeline,
        visibilityTiers: [],
        status: "draft",
        privateChannelId,
        publishedPostIds: {},
        applicationIds: [],
        createdAt: now,
        updatedAt: now
      };
      draft.jobs.push(record);
      return record;
    });
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    const snapshot = await this.store.get();
    return snapshot.jobs.find((job) => job.id === jobId) ?? null;
  }

  async listJobsByClient(clientId: string, marketTier?: Tier): Promise<JobRecord[]> {
    const snapshot = await this.store.get();
    return snapshot.jobs.filter(
      (job) => job.clientId === clientId && (!marketTier || job.marketTier === marketTier)
    );
  }

  async listApplicationsByDeveloper(devUserId: string, marketTier?: Tier): Promise<ApplicationRecord[]> {
    const snapshot = await this.store.get();
    const jobsById = new Map(snapshot.jobs.map((job) => [job.id, job]));

    return snapshot.applications.filter((application) => {
      if (application.devUserId !== devUserId) {
        return false;
      }

      if (!marketTier) {
        return true;
      }

      return jobsById.get(application.jobId)?.marketTier === marketTier;
    });
  }

  async listApplicationsByJob(jobId: string): Promise<ApplicationRecord[]> {
    const snapshot = await this.store.get();
    return snapshot.applications.filter((application) => application.jobId === jobId);
  }

  async getApplication(applicationId: string): Promise<ApplicationRecord | null> {
    const snapshot = await this.store.get();
    return snapshot.applications.find((application) => application.id === applicationId) ?? null;
  }

  async setApplicationReviewMessageId(applicationId: string, reviewMessageId: string): Promise<ApplicationRecord> {
    return this.store.mutate((draft) => {
      const application = draft.applications.find((item) => item.id === applicationId);
      if (!application) {
        throw new Error(`Application ${applicationId} was not found.`);
      }

      application.reviewMessageId = reviewMessageId;
      application.updatedAt = nowIso();
      return structuredClone(application);
    });
  }

  async setApplicationPrivateMessageId(applicationId: string, privateMessageId: string): Promise<ApplicationRecord> {
    return this.store.mutate((draft) => {
      const application = draft.applications.find((item) => item.id === applicationId);
      if (!application) {
        throw new Error(`Application ${applicationId} was not found.`);
      }

      application.privateMessageId = privateMessageId;
      application.updatedAt = nowIso();
      return structuredClone(application);
    });
  }

  async clearApplicationPrivateConversation(applicationId: string): Promise<ApplicationRecord> {
    return this.store.mutate((draft) => {
      const application = draft.applications.find((item) => item.id === applicationId);
      if (!application) {
        throw new Error(`Application ${applicationId} was not found.`);
      }

      delete application.privateChannelId;
      delete application.privateMessageId;
      application.updatedAt = nowIso();
      return structuredClone(application);
    });
  }

  async clearJobPrivateChannel(jobId: string): Promise<JobRecord> {
    return this.store.mutate((draft) => {
      const job = draft.jobs.find((item) => item.id === jobId);
      if (!job) {
        throw new Error(`Job ${jobId} was not found.`);
      }

      job.privateChannelId = "";
      job.updatedAt = nowIso();
      return structuredClone(job);
    });
  }

  async connectApplication(
    applicationId: string,
    privateChannelId: string,
    privateMessageId: string
  ): Promise<{ application: ApplicationRecord; job: JobRecord }> {
    return this.updateApplicationState(applicationId, (application) => {
      if (application.status !== "submitted") {
        throw new Error(`Application ${applicationId} is not awaiting review.`);
      }

      application.status = "connected";
      application.privateChannelId = privateChannelId;
      application.privateMessageId = privateMessageId;
    });
  }

  async rejectApplication(applicationId: string): Promise<{ application: ApplicationRecord; job: JobRecord }> {
    return this.updateApplicationState(applicationId, (application) => {
      if (application.status !== "submitted") {
        throw new Error(`Application ${applicationId} can no longer be rejected from review.`);
      }

      application.status = "rejected";
    });
  }

  async closeApplicationConversation(
    applicationId: string
  ): Promise<{ application: ApplicationRecord; job: JobRecord }> {
    return this.updateApplicationState(applicationId, (application) => {
      if (application.status !== "connected") {
        throw new Error(`Application ${applicationId} is not in an open conversation.`);
      }

      application.status = "closed";
    });
  }

  async hireApplication(applicationId: string): Promise<{ application: ApplicationRecord; job: JobRecord }> {
    return this.updateApplicationState(applicationId, (application, job, draft) => {
      if (application.status !== "connected") {
        throw new Error(`Application ${applicationId} is not ready to hire.`);
      }

      const alreadyHired = draft.applications.find(
        (item) => item.jobId === job.id && item.id !== application.id && item.status === "hired"
      );
      if (alreadyHired) {
        throw new Error(`Job ${job.id} already has a hired application.`);
      }

      application.status = "hired";
      job.status = "in_progress";
    });
  }

  async completeApplication(applicationId: string): Promise<{ application: ApplicationRecord; job: JobRecord }> {
    return this.updateApplicationState(applicationId, (application, job) => {
      if (application.status !== "hired") {
        throw new Error(`Application ${applicationId} is not in progress.`);
      }

      application.status = "completed";
      job.status = "closed";
    });
  }

  async stopApplication(applicationId: string): Promise<{ application: ApplicationRecord; job: JobRecord }> {
    return this.updateApplicationState(applicationId, (application, job) => {
      if (application.status !== "hired") {
        throw new Error(`Application ${applicationId} is not in progress.`);
      }

      application.status = "stopped";
      job.status = job.publishedPostIds[job.marketTier] ? "published" : "draft";
    });
  }

  async publishJob(jobId: string): Promise<string> {
    const snapshot = await this.store.get();
    const job = snapshot.jobs.find((item) => item.id === jobId);
    if (!job) {
      throw new Error(`Job ${jobId} was not found.`);
    }

    const tier = job.marketTier;
    const forumChannel = await this.client.channels.fetch(this.appConfig.forums.opportunities[tier]);
    if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) {
      throw new Error(`Opportunity forum for ${tier} is missing or invalid.`);
    }

    const forum = forumChannel as ForumChannel;
    const publishedJob: JobRecord = {
      ...job,
      status: "published",
      visibilityTiers: job.visibilityTiers.includes(tier) ? job.visibilityTiers : [...job.visibilityTiers, tier]
    };
    const publicThreadName = this.buildPublicJobThreadName(publishedJob);
    const existingThreadId = job.publishedPostIds[tier];
    const content = this.renderPublicJobPost(publishedJob);
    const components = this.buildPublicJobComponents(publishedJob);

    let threadId: string;

    if (existingThreadId) {
      const thread = await this.client.channels.fetch(existingThreadId).catch(() => null);
      if (thread?.isThread()) {
        const starterMessage = await thread.fetchStarterMessage().catch(() => null);
        if (starterMessage) {
          await starterMessage.edit({
            content,
            embeds: [],
            components
          });
        }
        await thread.setName(publicThreadName);
        threadId = thread.id;
      } else {
        const created = await forum.threads.create({
          name: publicThreadName,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
          message: {
            content,
            components
          }
        });
        threadId = created.id;
      }
    } else {
      const created = await forum.threads.create({
        name: publicThreadName,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        message: {
          content,
          components
        }
      });
      threadId = created.id;
    }

    await this.store.mutate((draft) => {
      const existing = draft.jobs.find((item) => item.id === job.id);
      if (!existing) {
        return;
      }

      existing.status = "published";
      if (!existing.visibilityTiers.includes(tier)) {
        existing.visibilityTiers.push(tier);
      }
      existing.publishedPostIds[tier] = threadId;
      existing.updatedAt = nowIso();
    });

    return threadId;
  }

  async closeJob(jobId: string): Promise<void> {
    const snapshot = await this.store.get();
    const job = snapshot.jobs.find((item) => item.id === jobId);
    if (!job) {
      throw new Error(`Job ${jobId} was not found.`);
    }

    const hasActiveHire = snapshot.applications.some(
      (application) => application.jobId === jobId && application.status === "hired"
    );
    if (hasActiveHire) {
      throw new Error(`Job ${jobId} still has an active hire.`);
    }

    await this.store.mutate((draft) => {
      const existing = draft.jobs.find((item) => item.id === jobId);
      if (!existing) {
        return;
      }

      const now = nowIso();
      existing.status = "closed";
      existing.updatedAt = now;

      for (const application of draft.applications) {
        if (application.jobId !== jobId) {
          continue;
        }

        if (["submitted", "connected", "shortlisted", "approved"].includes(application.status)) {
          application.status = "closed";
          application.updatedAt = now;
        }
      }
    });

    await this.refreshPublishedJobPosts(jobId);

    await Promise.all(
      Object.values(job.publishedPostIds).map(async (threadId) => {
        if (!threadId) {
          return;
        }

        const channel = await this.client.channels.fetch(threadId).catch(() => null);
        if (channel?.isThread()) {
          await channel.setArchived(true).catch(() => undefined);
          await channel.setLocked(true).catch(() => undefined);
        }
      })
    );
  }

  async createApplication(
    jobId: string,
    devUserId: string,
    payload: {
      pitch: string;
      matchingSkills: string[];
      rate: string;
      availability: string;
      privateChannelId?: string;
      origin?: ApplicationOrigin;
    }
  ): Promise<ApplicationRecord> {
    return this.store.mutate((draft) => {
      const job = draft.jobs.find((item) => item.id === jobId);
      if (!job) {
        throw new Error(`Job ${jobId} was not found.`);
      }

      const existingActive = draft.applications.find(
        (item) =>
          item.jobId === jobId &&
          item.devUserId === devUserId &&
          this.ACTIVE_APPLICATION_STATUSES.has(item.status)
      );
      if (existingActive) {
        throw new Error(`This candidate already has an active application for ${jobId}.`);
      }

      draft.counters.application += 1;
      const now = nowIso();
      const created: ApplicationRecord = {
        id: formatExternalId("APP", draft.counters.application),
        jobId,
        devUserId,
        origin: payload.origin ?? "developer_apply",
        pitch: payload.pitch,
        matchingSkills: payload.matchingSkills,
        rate: payload.rate,
        availability: payload.availability,
        status: "submitted",
        createdAt: now,
        updatedAt: now
      };

      if (payload.privateChannelId) {
        created.privateChannelId = payload.privateChannelId;
      }

      draft.applications.push(created);
      job.applicationIds.push(created.id);
      job.updatedAt = now;
      return created;
    });
  }

  async shortlist(jobId: string): Promise<ApplicationRecord[]> {
    const snapshot = await this.store.get();
    const job = snapshot.jobs.find((item) => item.id === jobId);
    if (!job) {
      throw new Error(`Job ${jobId} was not found.`);
    }

    const jobTokens = tokenize(job.skills.join(" "));
    const ranked = snapshot.applications
      .filter(
        (application) =>
          application.jobId === jobId &&
          !["withdrawn", "rejected", "closed", "completed", "stopped"].includes(application.status)
      )
      .map((application) => {
        const profile = snapshot.profiles.find((item) => item.userId === application.devUserId) ?? null;
        const score = this.scoreApplication(jobTokens, application, profile);
        return {
          ...application,
          score
        };
      })
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0));

    await this.store.mutate((draft) => {
      ranked.forEach((rankedApplication) => {
        const existing = draft.applications.find((item) => item.id === rankedApplication.id);
        if (existing) {
          existing.score = rankedApplication.score;
          existing.updatedAt = nowIso();
        }
      });
    });

    return ranked;
  }

  async suggestProfiles(
    jobId: string
  ): Promise<
    Array<{
      profile: ProfileRecord;
      score: number;
      fitScore: number;
      trustScore: number;
      tenureScore: number;
      linkScore: number;
      recentFeedbacks: FeedbackRecord[];
    }>
  > {
    const snapshot = await this.store.get();
    const job = snapshot.jobs.find((item) => item.id === jobId);
    if (!job) {
      throw new Error(`Job ${jobId} was not found.`);
    }

    const jobTokens = tokenize([job.title, job.summary, job.skills.join(" ")].join(" "));
    const eligibleTiers = new Set(getEligibleAccountTiersForMarket(job.marketTier));
    const ranked = snapshot.profiles
      .map((profile) => {
        const hasActiveApplication = snapshot.applications.some(
          (application) =>
            application.jobId === job.id &&
            application.devUserId === profile.userId &&
            this.ACTIVE_APPLICATION_STATUSES.has(application.status)
        );
        const profileTier = profile.approvedTier;
        if (
          hasActiveApplication ||
          !profileTier ||
          !eligibleTiers.has(profileTier) ||
          profile.status !== "approved"
        ) {
          return null;
        }

        const scored = this.scoreProfileSuggestion(jobTokens, profile);
        const recentFeedbacks = snapshot.feedbacks
          .filter((feedback) => feedback.devUserId === profile.userId)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .slice(0, 2);
        return {
          profile,
          recentFeedbacks,
          ...scored
        };
      })
      .filter((item) => item !== null)
      .sort((left, right) => right.score - left.score)
      .slice(0, 50);

    return ranked;
  }

  buildSuggestionInviteButtons(
    jobId: string,
    devUserId: string,
    disabled = false
  ): ActionRowBuilder<ButtonBuilder>[] {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`job|invite|${jobId}|${devUserId}`)
          .setLabel(disabled ? "Invited" : "Invite To Chat")
          .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Success)
          .setDisabled(disabled)
      )
    ];
  }

  buildClientDeskEmbed(tier: Tier): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle(`${getTierLabel(tier)} Client Desk`)
      .setDescription(
        [
          `Create jobs for the ${getTierLabel(tier)} market and publish them into the ${getTierLabel(tier)} opportunities channel.`,
          "Your identity and search history stay private.",
          "This desk only manages jobs scoped to this network tier."
        ].join("\n")
      )
      .setColor(0x00a86b);
  }

  buildClientDeskComponents(tier: Tier): ActionRowBuilder<ButtonBuilder>[] {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`desk|new_job|${tier}`)
          .setLabel("New Job")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`desk|my_jobs|${tier}`)
          .setLabel("My Jobs")
          .setStyle(ButtonStyle.Secondary)
      )
    ];
  }

  buildJobManagementButtons(job: JobRecord): ActionRowBuilder<ButtonBuilder>[] {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`job|publish|${job.id}`)
          .setLabel(`Publish ${getTierLabel(job.marketTier)}`)
          .setStyle(ButtonStyle.Primary)
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`job|suggest|${job.id}`)
          .setLabel("Suggest Developers")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`job|shortlist|${job.id}`)
          .setLabel("Request Shortlist")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`job|close|${job.id}`)
          .setLabel("Close Job")
          .setStyle(ButtonStyle.Danger)
      )
    ];
  }

  buildPublicJobComponents(job: JobRecord): ActionRowBuilder<ButtonBuilder>[] {
    if (job.status === "published") {
      return [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`job|apply|${job.id}`)
            .setLabel("Apply")
            .setStyle(ButtonStyle.Success)
        )
      ];
    }

    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`job|apply|${job.id}`)
          .setLabel(this.getPublicJobButtonLabel(job.status))
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true)
      )
    ];
  }

  renderApplicationReviewCard(
    job: JobRecord,
    application: ApplicationRecord,
    profile: ProfileRecord | null
  ): string {
    const contextHeading = application.origin === "client_invite" ? "Invite Context" : "Pitch";

    return [
      `## Application ${this.formatApplicationSequence(job, application)}`,
      `**Status:** ${this.formatApplicationStatus(application.status)}`,
      `**Entry:** ${this.formatApplicationOrigin(application.origin)}`,
      `**Market:** ${getTierLabel(job.marketTier)}`,
      `**Talent:** <@${application.devUserId}>`,
      ...this.buildProfileSummaryLines(profile),
      ...this.buildApplicationDetailLines(application),
      "",
      `### ${contextHeading}`,
      application.pitch
    ].join("\n");
  }

  buildApplicationReviewButtons(
    application: ApplicationRecord,
    jobStatus: JobRecord["status"]
  ): ActionRowBuilder<ButtonBuilder>[] {
    if (application.status !== "submitted") {
      return [];
    }

    const connectDisabled = jobStatus === "in_progress";

    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`application|connect|${application.id}`)
          .setLabel(connectDisabled ? "Connect Unavailable" : "Connect")
          .setStyle(ButtonStyle.Success)
          .setDisabled(connectDisabled),
        new ButtonBuilder()
          .setCustomId(`application|reject|${application.id}`)
          .setLabel("Reject")
          .setStyle(ButtonStyle.Danger)
      )
    ];
  }

  renderApplicationConversationCard(
    job: JobRecord,
    application: ApplicationRecord,
    profile: ProfileRecord | null
  ): string {
    const lines = [
      `# ${application.id} conversation`,
      "",
      `**Entry:** ${this.formatApplicationOrigin(application.origin)}`,
      `**Job:** ${job.id} - ${job.title}`,
      `**Market:** ${getTierLabel(job.marketTier)}`,
      `**Client:** <@${job.clientId}>`,
      `**Talent:** <@${application.devUserId}>`,
      `**Status:** ${this.formatApplicationStatus(application.status)}`,
      ...this.buildProfileSummaryLines(profile),
      ...this.buildApplicationDetailLines(application)
    ];

    if (application.origin === "client_invite") {
      lines.push(
        "",
        "### Invitation Context",
        application.pitch,
        "",
        "### Job Overview",
        job.summary
      );
    } else {
      lines.push("", "### Pitch", application.pitch);
    }

    return lines.join("\n");
  }

  buildApplicationConversationButtons(
    application: ApplicationRecord,
    jobStatus: JobRecord["status"]
  ): ActionRowBuilder<ButtonBuilder>[] {
    if (application.status === "connected") {
      const hireDisabled = jobStatus === "in_progress";

      return [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`application|hire|${application.id}`)
            .setLabel(hireDisabled ? "Hire Unavailable" : "Hire")
            .setStyle(ButtonStyle.Success)
            .setDisabled(hireDisabled),
          new ButtonBuilder()
            .setCustomId(`application|close|${application.id}`)
            .setLabel("Close")
            .setStyle(ButtonStyle.Danger)
        )
      ];
    }

    if (application.status === "hired") {
      return [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`application|complete|${application.id}`)
            .setLabel("Complete")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`application|stop|${application.id}`)
            .setLabel("Stop")
            .setStyle(ButtonStyle.Danger)
        )
      ];
    }

    return [];
  }

  renderPrivateJobSummary(job: JobRecord): string {
    const visibleIn = job.visibilityTiers.length > 0 ? job.visibilityTiers.join(", ") : "not published yet";
    const publishedIds = Object.entries(job.publishedPostIds)
      .map(([tier, postId]) => `- ${tier}: ${postId}`)
      .join("\n");
    const budget = job.budget || "Not specified";
    const timeline = job.timeline || "Not specified";
    const skills = job.skills.join(", ") || "Not specified";

    return [
      `# ${job.id} • ${job.title}`,
      "",
      `**Market:** ${getTierLabel(job.marketTier)}`,
      `**Status:** ${job.status}`,
      `**Budget:** ${budget}`,
      `**Timeline:** ${timeline}`,
      `**Skills:** ${skills}`,
      `**Visible In:** ${visibleIn}`,
      "",
      "## Summary",
      job.summary,
      "",
      "## Published Posts",
      publishedIds || "- none yet"
    ].join("\n");
  }

  formatShortlist(job: JobRecord, applications: ApplicationRecord[]): string {
    if (applications.length === 0) {
      return `# ${job.id} shortlist\n\nNo applications found yet.`;
    }

    const lines = applications.slice(0, 10).map((application, index) => {
      const rate = application.rate || "not specified";
      const availability = application.availability || "not specified";

      return [
        `${index + 1}. <@${application.devUserId}>`,
        `   - application: ${application.id}`,
        `   - market: ${getTierLabel(job.marketTier)}`,
        `   - score: ${application.score ?? 0}`,
        `   - skills: ${application.matchingSkills.join(", ") || "none"}`,
        `   - rate: ${rate}`,
        `   - availability: ${availability}`
      ].join("\n");
    });

    return [`# ${job.id} shortlist`, "", ...lines].join("\n");
  }

  formatProfileSuggestionsMessages(
    job: JobRecord,
    suggestions: Array<{
      profile: ProfileRecord;
      score: number;
      fitScore: number;
      trustScore: number;
      tenureScore: number;
      linkScore: number;
      recentFeedbacks: FeedbackRecord[];
    }>
  ): Array<{
    content: string;
    components: ActionRowBuilder<ButtonBuilder>[];
  }> {
    if (suggestions.length === 0) {
      return [
        {
          content: `# ${job.id} suggestions\n\nNo published developer profiles matched this ${getTierLabel(job.marketTier).toLowerCase()} market job yet.`,
          components: []
        }
      ];
    }

    const messages = suggestions.map((suggestion, index) => {
      const skills = suggestion.profile.skills.join(", ") || "none";
      const tier = suggestion.profile.approvedTier ? getTierLabel(suggestion.profile.approvedTier) : "Unassigned";
      const rating = this.formatAverageStars(suggestion.profile.feedbackAverage, suggestion.profile.feedbackCount);
      const recentFeedbackLines = suggestion.recentFeedbacks.map((feedback) => {
        const status = feedback.outcome === "completed" ? "success" : "fail";
        const snippet = feedback.message ? ` - ${this.truncate(feedback.message, 80)}` : "";
        return `- ${this.formatScoreStars(feedback.score)} | ${status}${snippet}`;
      });

      const contentLines = [
        `## Candidate #${(index + 1).toString().padStart(3, "0")}`,
        `**Title:** ${suggestion.profile.headline}`,
        `**Network:** ${tier}`,
        `**Total Score:** ${suggestion.score}`,
        `**Fit / Trust / Tenure / Links:** ${suggestion.fitScore} / ${suggestion.trustScore} / ${suggestion.tenureScore} / ${suggestion.linkScore}`,
        `**Client Rating:** ${rating}`,
        `**Skills:** ${skills}`
      ];

      if (recentFeedbackLines.length > 0) {
        contentLines.push("", "### Recent Feedback", ...recentFeedbackLines);
      }

      return {
        content: contentLines.join("\n"),
        components: this.buildSuggestionInviteButtons(job.id, suggestion.profile.userId)
      };
    });

    return [
      {
        content: [
          `# ${job.id} suggestions`,
          "",
          `Matched for the ${getTierLabel(job.marketTier)} market.`,
          "Developer identities stay hidden until you invite a candidate into a shared room."
        ].join("\n"),
        components: []
      },
      ...messages
    ];
  }

  async refreshPublishedJobPosts(jobId: string): Promise<void> {
    const job = await this.getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} was not found.`);
    }

    await Promise.all(
      Object.entries(job.publishedPostIds).map(async ([, threadId]) => {
        if (!threadId) {
          return;
        }

        const thread = await this.client.channels.fetch(threadId).catch(() => null);
        if (!thread?.isThread()) {
          return;
        }

        const starterMessage = await thread.fetchStarterMessage().catch(() => null);
        if (!starterMessage) {
          return;
        }

        await thread.setName(this.buildPublicJobThreadName(job)).catch(() => undefined);
        await starterMessage.edit({
          content: this.renderPublicJobPost(job),
          embeds: [],
          components: this.buildPublicJobComponents(job)
        });
      })
    );
  }

  private renderPublicJobPost(job: JobRecord): string {
    const budget = job.budget || "N/A";
    const timeline = job.timeline || "N/A";
    const skills = this.formatPublicSkillTags(job.skills);

    return [
      `# ${job.title}`,
      "",
      `**Network:** ${this.getTierBadge(job.marketTier)}`,
      "",
      `**Budget:** ${budget}`,
      `**Timeline:** ${timeline}`,
      `**Skills:** ${skills}`,
      "",
      "## Overview",
      job.summary,
      "",
      `**Status:** ${this.getPublicStatusBadge(job.status)}`,
      ""
    ].join("\n");
  }

  private buildApplicationDetailLines(application: ApplicationRecord): string[] {
    const lines: string[] = [];

    if (application.privateChannelId) {
      lines.push(`**Room:** <#${application.privateChannelId}>`);
    }

    if (application.rate) {
      lines.push(`**Rate:** ${application.rate}`);
    }

    if (application.availability) {
      lines.push(`**Availability:** ${application.availability}`);
    }

    return lines;
  }

  private buildProfileSummaryLines(profile: ProfileRecord | null): string[] {
    if (!profile) {
      return ["**Profile:** not published"];
    }

    const skills = profile.skills.length > 0 ? profile.skills.join(", ") : "none";
    const tier = profile.approvedTier ? getTierLabel(profile.approvedTier) : "Unassigned";

    return [
      `**Profile:** ${profile.headline}`,
      `**Talent Tier:** ${tier}`,
      `**Profile Skills:** ${skills}`
    ];
  }

  private formatApplicationSequence(job: JobRecord, application: ApplicationRecord): string {
    const index = job.applicationIds.indexOf(application.id);
    if (index === -1) {
      return application.id;
    }

    return `#${(index + 1).toString().padStart(3, "0")}`;
  }

  private formatApplicationStatus(status: ApplicationRecord["status"]): string {
    return status.replace(/_/g, " ");
  }

  private formatApplicationOrigin(origin: ApplicationOrigin): string {
    return origin === "client_invite" ? "client invite" : "developer application";
  }

  private getPublicJobButtonLabel(status: JobRecord["status"]): string {
    switch (status) {
      case "in_progress":
        return "In Progress";
      case "closed":
        return "Closed";
      case "paused":
        return "Paused";
      case "draft":
        return "Draft";
      default:
        return "Unavailable";
    }
  }

  private buildPublicJobThreadName(job: JobRecord): string {
    return job.title;
  }

  private formatPublicSkillTags(skills: string[]): string {
    if (skills.length === 0) {
      return "N/A";
    }

    return skills.map((skill) => `\`${skill}\``).join(" ");
  }

  private getTierBadge(tier: Tier): string {
    switch (tier) {
      case "gold":
        return "🥇 Gold";
      case "silver":
        return "🥈 Silver";
      case "copper":
        return "🥉 Copper";
    }
  }

  private getPublicStatusBadge(status: JobRecord["status"]): string {
    switch (status) {
      case "published":
        return "🟢 Open";
      case "in_progress":
        return "🟠 In progress";
      case "closed":
        return "🔴 Closed";
      case "paused":
        return "⏸️ Paused";
      case "draft":
        return "📝 Preparing";
    }
  }

  private async updateApplicationState(
    applicationId: string,
    updater: (
      application: ApplicationRecord,
      job: JobRecord,
      draft: { applications: ApplicationRecord[]; jobs: JobRecord[] }
    ) => void
  ): Promise<{ application: ApplicationRecord; job: JobRecord }> {
    return this.store.mutate((draft) => {
      const application = draft.applications.find((item) => item.id === applicationId);
      if (!application) {
        throw new Error(`Application ${applicationId} was not found.`);
      }

      const job = draft.jobs.find((item) => item.id === application.jobId);
      if (!job) {
        throw new Error(`Job ${application.jobId} was not found.`);
      }

      updater(application, job, draft);

      const now = nowIso();
      application.updatedAt = now;
      job.updatedAt = now;

      return {
        application: structuredClone(application),
        job: structuredClone(job)
      };
    });
  }

  private scoreApplication(
    jobTokens: string[],
    application: ApplicationRecord,
    profile: ProfileRecord | null
  ): number {
    const appTokens = tokenize(application.matchingSkills.join(" "));
    const profileTokens = profile ? tokenize(profile.skills.join(" ")) : [];
    const tokenScore = overlapScore(jobTokens, [...appTokens, ...profileTokens]) * 10;
    const trustScore = profile?.trustScore ?? 40;
    const starScore = (profile?.moderatorStars ?? 0) * 15;
    return tokenScore + trustScore + starScore;
  }

  private scoreProfileSuggestion(jobTokens: string[], profile: ProfileRecord): {
    score: number;
    fitScore: number;
    trustScore: number;
    tenureScore: number;
    linkScore: number;
  } {
    const profileTokens = tokenize(
      [profile.headline, profile.bio, profile.previousProjects, profile.skills.join(" "), profile.portfolioLinks.join(" ")]
        .join(" ")
    );
    const fitScore = overlapScore(jobTokens, profileTokens) * 8;
    const trustScore = Math.max(
      0,
      Math.round(profile.trustScore * 0.4) +
        profile.moderatorStars * 6 +
        profile.completedContracts * 4 -
        profile.stoppedContracts * 3 -
        profile.disputeCount * 8 +
        Math.round(profile.feedbackAverage * 4)
    );
    const tenureScore = this.getTenureScore(profile.networkRegisteredAt || profile.createdAt);
    const linkScore = this.getProfileLinkScore(profile.portfolioLinks);

    return {
      score: fitScore + trustScore + tenureScore + linkScore,
      fitScore,
      trustScore,
      tenureScore,
      linkScore
    };
  }

  private getTenureScore(networkRegisteredAt: string): number {
    const createdAt = new Date(networkRegisteredAt);
    if (Number.isNaN(createdAt.getTime())) {
      return 0;
    }

    const ageInDays = Math.max(0, (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
    return Math.min(12, Math.round(ageInDays / 30));
  }

  private getProfileLinkScore(links: string[]): number {
    let score = 0;

    for (const link of links) {
      const value = link.toLowerCase();
      if (value.includes("github.com")) {
        score += 4;
        continue;
      }

      if (value.includes("linkedin.com")) {
        score += 1;
        continue;
      }

      score += 2;
    }

    return Math.min(score, 10);
  }

  private formatScoreStars(score: number): string {
    const safeScore = Math.max(1, Math.min(5, Math.round(score)));
    return `${this.EMOJIS.full.repeat(safeScore)}${this.EMOJIS.empty.repeat(5 - safeScore)} ${safeScore}/5`;
  }

  private formatAverageStars(average: number, count: number): string {
    if (count === 0) {
      return "N/A";
    }

    const rounded = Math.round(average * 2) / 2;
    const full = Math.floor(rounded);
    const hasHalf = rounded % 1 !== 0;

    let stars = "";
    stars += this.EMOJIS.full.repeat(full);

    if (hasHalf) {
      stars += this.EMOJIS.half;
    }

    const totalStars = full + (hasHalf ? 1 : 0);
    stars += this.EMOJIS.empty.repeat(5 - totalStars);

    return `${stars} ${average.toFixed(1)}/5 from ${count}`;
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }

    return `${value.slice(0, maxLength - 3)}...`;
  }
}
