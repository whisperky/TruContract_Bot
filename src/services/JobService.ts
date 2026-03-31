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
import type { ApplicationRecord, JobRecord, ProfileRecord, Tier } from "../domain/models.js";
import { JsonStore } from "../storage/JsonStore.js";
import { formatExternalId, nowIso } from "../utils/id.js";
import { overlapScore, tokenize } from "../utils/text.js";

export class JobService {
  constructor(
    private readonly client: Client,
    private readonly store: JsonStore,
    private readonly appConfig: AppConfig
  ) {}

  async createJob(
    clientUserId: string,
    privateChannelId: string,
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

  async listJobsByClient(clientId: string): Promise<JobRecord[]> {
    const snapshot = await this.store.get();
    return snapshot.jobs.filter((job) => job.clientId === clientId);
  }

  async listApplicationsByDeveloper(devUserId: string): Promise<ApplicationRecord[]> {
    const snapshot = await this.store.get();
    return snapshot.applications.filter((application) => application.devUserId === devUserId);
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
      job.status = job.visibilityTiers.length > 0 ? "published" : "draft";
    });
  }

  async publishJob(jobId: string, tier: Tier): Promise<string> {
    const snapshot = await this.store.get();
    const job = snapshot.jobs.find((item) => item.id === jobId);
    if (!job) {
      throw new Error(`Job ${jobId} was not found.`);
    }

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
    const content = this.renderPublicJobPost(publishedJob, tier);
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

    await this.store.mutate((draft) => {
      const existing = draft.jobs.find((item) => item.id === jobId);
      if (existing) {
        existing.status = "closed";
        existing.updatedAt = nowIso();
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
    }
  ): Promise<ApplicationRecord> {
    return this.store.mutate((draft) => {
      const job = draft.jobs.find((item) => item.id === jobId);
      if (!job) {
        throw new Error(`Job ${jobId} was not found.`);
      }

      draft.counters.application += 1;
      const now = nowIso();
      const created: ApplicationRecord = {
        id: formatExternalId("APP", draft.counters.application),
        jobId,
        devUserId,
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
    jobId: string,
    allowedTiers: Tier[]
  ): Promise<
    Array<{
      profile: ProfileRecord;
      threadId: string;
      score: number;
      fitScore: number;
      trustScore: number;
      tenureScore: number;
      linkScore: number;
    }>
  > {
    const snapshot = await this.store.get();
    const job = snapshot.jobs.find((item) => item.id === jobId);
    if (!job) {
      throw new Error(`Job ${jobId} was not found.`);
    }

    const jobTokens = tokenize([job.title, job.summary, job.skills.join(" ")].join(" "));
    const ranked = snapshot.profiles
      .map((profile) => {
        const threadId = this.getVisibleProfileThreadId(profile, allowedTiers);
        if (!threadId || profile.status !== "approved") {
          return null;
        }

        const scored = this.scoreProfileSuggestion(jobTokens, profile);
        return {
          profile,
          threadId,
          ...scored
        };
      })
      .filter((item) => item !== null)
      .sort((left, right) => right.score - left.score)
      .slice(0, 50);

    return ranked;
  }

  buildClientDeskEmbed(): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle("Client Desk")
      .setDescription(
        [
          "Open a private client room and let the bot publish anonymized job posts for you.",
          "Your identity and search history stay private.",
          "Use this desk for new jobs, shortlist requests, and privacy issues."
        ].join("\n")
      )
      .setColor(0x00a86b);
  }

  buildClientDeskComponents(): ActionRowBuilder<ButtonBuilder>[] {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("desk|new_job")
          .setLabel("New Job")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("desk|my_jobs")
          .setLabel("My Jobs")
          .setStyle(ButtonStyle.Secondary)
      )
    ];
  }

  buildJobManagementButtons(jobId: string): ActionRowBuilder<ButtonBuilder>[] {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`job|publish|${jobId}|gold`)
          .setLabel("Publish Gold")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`job|publish|${jobId}|silver`)
          .setLabel("Publish Silver")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`job|publish|${jobId}|copper`)
          .setLabel("Publish Copper")
          .setStyle(ButtonStyle.Primary)
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`job|suggest|${jobId}`)
          .setLabel("Suggest Developers")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`job|shortlist|${jobId}`)
          .setLabel("Request Shortlist")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`job|close|${jobId}`)
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
    profileThreadId: string | null
  ): string {
    return [
      `## Application ${this.formatApplicationSequence(job, application)}`,
      `**Status:** ${this.formatApplicationStatus(application.status)}`,
      `**Talent:** <@${application.devUserId}>`,
      `**Profile:** ${profileThreadId ? `<#${profileThreadId}>` : "not published"}`,
      ...this.buildApplicationDetailLines(application),
      "",
      "### Pitch",
      application.pitch
    ].join("\n");
  }

  buildApplicationReviewButtons(application: ApplicationRecord): ActionRowBuilder<ButtonBuilder>[] {
    if (application.status !== "submitted") {
      return [];
    }

    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`application|connect|${application.id}`)
          .setLabel("Connect")
          .setStyle(ButtonStyle.Success),
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
    profileThreadId: string | null
  ): string {
    return [
      `# ${application.id} conversation`,
      "",
      `**Job:** ${job.id} - ${job.title}`,
      `**Client:** <@${job.clientId}>`,
      `**Talent:** <@${application.devUserId}>`,
      `**Status:** ${this.formatApplicationStatus(application.status)}`,
      `**Profile:** ${profileThreadId ? `<#${profileThreadId}>` : "not published"}`,
      ...this.buildApplicationDetailLines(application),
      "",
      "### Pitch",
      application.pitch
    ].join("\n");
  }

  buildApplicationConversationButtons(application: ApplicationRecord): ActionRowBuilder<ButtonBuilder>[] {
    if (application.status === "connected") {
      return [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`application|hire|${application.id}`)
            .setLabel("Hire")
            .setStyle(ButtonStyle.Success),
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
    const tiers = job.visibilityTiers.length > 0 ? job.visibilityTiers.join(", ") : "not published yet";
    const publishedIds = Object.entries(job.publishedPostIds)
      .map(([tier, postId]) => `- ${tier}: ${postId}`)
      .join("\n");
    const budget = job.budget || "Not specified";
    const timeline = job.timeline || "Not specified";
    const skills = job.skills.join(", ") || "Not specified";

    return [
      `# ${job.id} • ${job.title}`,
      "",
      `**Status:** ${job.status}`,
      `**Budget:** ${budget}`,
      `**Timeline:** ${timeline}`,
      `**Skills:** ${skills}`,
      `**Visible In:** ${tiers}`,
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
      threadId: string;
      score: number;
      fitScore: number;
      trustScore: number;
      tenureScore: number;
      linkScore: number;
    }>
  ): string[] {
    if (suggestions.length === 0) {
      return [`# ${job.id} suggestions\n\nNo published developer profiles matched this job yet.`];
    }

    const lines = suggestions.map((suggestion, index) => {
      const skills = suggestion.profile.skills.join(", ") || "none";
      const tier = suggestion.profile.approvedTier ?? "unassigned";

      return [
        `${index + 1}. <@${suggestion.profile.userId}>`,
        `   - profile: <#${suggestion.threadId}>`,
        `   - title: ${suggestion.profile.headline}`,
        `   - network: ${tier}`,
        `   - total: ${suggestion.score}`,
        `   - fit/trust/tenure/links: ${suggestion.fitScore}/${suggestion.trustScore}/${suggestion.tenureScore}/${suggestion.linkScore}`,
        `   - skills: ${skills}`
      ].join("\n");
    });

    const chunks: string[] = [];
    for (let index = 0; index < lines.length; index += 10) {
      const chunkLines = lines.slice(index, index + 10);
      const title = index === 0 ? `# ${job.id} suggestions` : `# ${job.id} suggestions (cont.)`;
      chunks.push([title, "", ...chunkLines].join("\n"));
    }

    return chunks;
  }

  private renderPublicJobPost(job: JobRecord, tier: Tier): string {
    const budget = job.budget || "N/A";
    const timeline = job.timeline || "N/A";
    const skills = this.formatPublicSkillTags(job.skills);

    return [
      `# ${job.title}`,
      "",
      `**Network:** ${this.getTierBadge(tier)}`,
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

  async refreshPublishedJobPosts(jobId: string): Promise<void> {
    const job = await this.getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} was not found.`);
    }

    await Promise.all(
      Object.entries(job.publishedPostIds).map(async ([tier, threadId]) => {
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
          content: this.renderPublicJobPost(job, tier as Tier),
          embeds: [],
          components: this.buildPublicJobComponents(job)
        });
      })
    );
  }

  private buildApplicationDetailLines(application: ApplicationRecord): string[] {
    const lines = [];

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
        return "🟢  Open";
      case "in_progress":
        return "🟠  In progress";
      case "closed":
        return "🔴  Closed";
      case "paused":
        return "⏸️  Paused";
      case "draft":
        return "📝  Preparing";
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
        profile.disputeCount * 8
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

  private getVisibleProfileThreadId(profile: ProfileRecord, allowedTiers: Tier[]): string | null {
    for (const tier of allowedTiers) {
      const threadId = profile.publishedPostIds[tier];
      if (threadId) {
        return threadId;
      }
    }

    return null;
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
}
