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
    const threadName = `${job.id} • ${job.title}`;
    const existingThreadId = job.publishedPostIds[tier];
    const content = this.renderPublicJobCard(job, tier);
    const components = [this.buildPublicJobButtons(job.id)];

    let threadId: string;

    if (existingThreadId) {
      const thread = await this.client.channels.fetch(existingThreadId).catch(() => null);
      if (thread?.isThread()) {
        const starterMessage = await thread.fetchStarterMessage().catch(() => null);
        if (starterMessage) {
          await starterMessage.edit({ content, components });
        }
        await thread.setName(threadName);
        threadId = thread.id;
      } else {
        const created = await forum.threads.create({
          name: threadName,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
          message: { content, components }
        });
        threadId = created.id;
      }
    } else {
      const created = await forum.threads.create({
        name: threadName,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        message: { content, components }
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
      .filter((application) => application.jobId === jobId && application.status !== "withdrawn")
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

  buildPublicJobButtons(jobId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`job|apply|${jobId}`)
        .setLabel("Apply")
        .setStyle(ButtonStyle.Success)
    );
  }

  renderPrivateJobSummary(job: JobRecord): string {
    const tiers = job.visibilityTiers.length > 0 ? job.visibilityTiers.join(", ") : "not published yet";
    const publishedIds = Object.entries(job.publishedPostIds)
      .map(([tier, postId]) => `- ${tier}: ${postId}`)
      .join("\n");

    return [
      `# ${job.id} • ${job.title}`,
      "",
      `**Status:** ${job.status}`,
      `**Budget:** ${job.budget}`,
      `**Timeline:** ${job.timeline}`,
      `**Skills:** ${job.skills.join(", ") || "none"}`,
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
      return [
        `${index + 1}. <@${application.devUserId}>`,
        `   - application: ${application.id}`,
        `   - score: ${application.score ?? 0}`,
        `   - skills: ${application.matchingSkills.join(", ") || "none"}`,
        `   - rate: ${application.rate}`,
        `   - availability: ${application.availability}`
      ].join("\n");
    });

    return [`# ${job.id} shortlist`, "", ...lines].join("\n");
  }

  private renderPublicJobCard(job: JobRecord, tier: Tier): string {
    return [
      `# ${job.id} • ${job.title}`,
      "",
      `**Tier Feed:** ${tier}`,
      `**Budget:** ${job.budget}`,
      `**Timeline:** ${job.timeline}`,
      `**Skills:** ${job.skills.join(", ") || "none"}`,
      "",
      "## Summary",
      job.summary,
      "",
      "_This opportunity is published anonymously by the Trust Contract bot. Do not request direct client contact._"
    ].join("\n");
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
}
