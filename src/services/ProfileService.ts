import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ForumChannel,
  ThreadAutoArchiveDuration,
  type Client,
  type GuildMember
} from "discord.js";

import type { AppConfig } from "../config.js";
import type { FeedbackRecord, ProfileRecord, Tier } from "../domain/models.js";
import { JsonStore } from "../storage/JsonStore.js";
import { formatExternalId, nowIso } from "../utils/id.js";
import { getDevTier } from "../utils/discord.js";

const PROFILE_TIERS: Tier[] = ["gold", "silver", "copper"];

export class ProfileService {
  constructor(
    private readonly client: Client,
    private readonly store: JsonStore,
    private readonly appConfig: AppConfig
  ) {}

  private EMOJIS = {
    full: "<:star_full:1488689485720981534>",
    half: "<:star_half:1488689511104905216>",
    empty: "<:star_empty:1488689461893140480>",
  };

  async submitProfile(
    member: GuildMember,
    payload: {
      headline: string;
      bio: string;
      previousProjects: string;
      skills: string[];
      portfolioLinks: string[];
    }
  ): Promise<ProfileRecord> {
    const profile = await this.store.mutate((draft) => {
      const now = nowIso();
      const existing = draft.profiles.find((item) => item.userId === member.id);
      const initialTier = existing?.approvedTier ?? getDevTier(member, this.appConfig);
      if (!initialTier) {
        throw new Error("A developer tier role is required before creating a public profile.");
      }

      if (existing) {
        existing.headline = payload.headline;
        existing.bio = payload.bio;
        existing.previousProjects = payload.previousProjects;
        existing.skills = payload.skills;
        existing.portfolioLinks = payload.portfolioLinks;
        existing.status = "approved";
        existing.approvedTier = existing.approvedTier ?? initialTier;
        existing.visibilityTiers =
          existing.visibilityTiers.length > 0 ? existing.visibilityTiers : [existing.approvedTier];
        existing.networkRegisteredAt =
          existing.networkRegisteredAt || member.joinedAt?.toISOString() || existing.createdAt;
        existing.updatedAt = now;
        return structuredClone(existing);
      }

      draft.counters.profile += 1;
      const created: ProfileRecord = {
        id: formatExternalId("PRO", draft.counters.profile),
        userId: member.id,
        headline: payload.headline,
        bio: payload.bio,
        previousProjects: payload.previousProjects,
        skills: payload.skills,
        portfolioLinks: payload.portfolioLinks,
        availability: "",
        trustScore: 50,
        moderatorStars: 0,
        completedContracts: 0,
        stoppedContracts: 0,
        disputeCount: 0,
        feedbackCount: 0,
        feedbackAverage: 0,
        status: "approved",
        approvedTier: initialTier,
        visibilityTiers: [initialTier],
        networkRegisteredAt: member.joinedAt?.toISOString() ?? now,
        publishedPostIds: {},
        createdAt: now,
        updatedAt: now
      };

      draft.profiles.push(created);
      return structuredClone(created);
    });

    return this.syncPublishedProfile(member, profile);
  }

  async approveProfile(
    member: GuildMember,
    tier: Tier,
    stars: number,
    trustScore: number,
    disputeCount?: number
  ): Promise<ProfileRecord> {
    const profile = await this.store.mutate((draft) => {
      const existing = draft.profiles.find((item) => item.userId === member.id);
      if (!existing) {
        throw new Error("Profile not found for that user.");
      }

      existing.status = "approved";
      existing.approvedTier = tier;
      existing.visibilityTiers = [tier];
      existing.moderatorStars = stars;
      existing.trustScore = trustScore;
      if (disputeCount !== undefined) {
        existing.disputeCount = disputeCount;
      }
      existing.networkRegisteredAt =
        existing.networkRegisteredAt || member.joinedAt?.toISOString() || existing.createdAt;
      existing.updatedAt = nowIso();
      return structuredClone(existing);
    });

    return this.syncPublishedProfile(member, profile);
  }

  async addFeedback(
    member: GuildMember,
    payload: {
      jobId: string;
      applicationId: string;
      clientUserId: string;
      jobTitle: string;
      outcome: "completed" | "stopped";
      score: number;
      message: string;
    }
  ): Promise<FeedbackRecord> {
    const result = await this.store.mutate((draft) => {
      const profile = draft.profiles.find((item) => item.userId === member.id);
      if (!profile) {
        throw new Error(`Profile for ${member.id} was not found.`);
      }

      const application = draft.applications.find((item) => item.id === payload.applicationId);
      if (!application) {
        throw new Error(`Application ${payload.applicationId} was not found.`);
      }

      if (application.feedbackId) {
        throw new Error(`Application ${payload.applicationId} already has feedback.`);
      }

      draft.counters.feedback += 1;
      const created: FeedbackRecord = {
        id: formatExternalId("FDB", draft.counters.feedback),
        jobId: payload.jobId,
        applicationId: payload.applicationId,
        clientUserId: payload.clientUserId,
        devUserId: member.id,
        jobTitle: payload.jobTitle,
        outcome: payload.outcome,
        score: payload.score,
        message: payload.message,
        createdAt: nowIso()
      };

      draft.feedbacks.push(created);
      application.feedbackId = created.id;

      if (payload.outcome === "completed") {
        profile.completedContracts += 1;
      } else {
        profile.stoppedContracts += 1;
      }

      const trustDelta = (payload.score - 3) * 2 + (payload.outcome === "completed" ? 1 : -1);
      profile.trustScore = Math.max(0, Math.min(100, profile.trustScore + trustDelta));

      const profileFeedbacks = draft.feedbacks.filter((item) => item.devUserId === member.id);
      const totalScore = profileFeedbacks.reduce((sum, item) => sum + item.score, 0);
      profile.feedbackCount = profileFeedbacks.length;
      profile.feedbackAverage =
        profileFeedbacks.length > 0 ? Number((totalScore / profileFeedbacks.length).toFixed(2)) : 0;
      profile.updatedAt = nowIso();

      return {
        feedback: structuredClone(created),
        profile: structuredClone(profile)
      };
    });

    const syncedProfile = await this.syncPublishedProfile(member, result.profile);
    await this.postFeedbackToPublishedThreads(syncedProfile, result.feedback);
    return result.feedback;
  }

  async getProfileByUserId(userId: string): Promise<ProfileRecord | null> {
    const snapshot = await this.store.get();
    return snapshot.profiles.find((profile) => profile.userId === userId) ?? null;
  }

  buildDeskEmbed(): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle("Developer Desk")
      .setDescription(
        [
          "Create or update your public developer profile.",
          "Once submitted, the bot syncs your profile into your allowed network forum.",
          "Clients discover published profiles through private ranked suggestions, not random forum scrolling."
        ].join("\n")
      )
      .setColor(0x2b90d9);
  }

  buildDeskComponents(): ActionRowBuilder<ButtonBuilder>[] {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("desk|dev_profile")
          .setLabel("Create / Update Profile")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("desk|my_applications")
          .setLabel("My Applications")
          .setStyle(ButtonStyle.Secondary)
      )
    ];
  }

  private async syncPublishedProfile(member: GuildMember, profile: ProfileRecord): Promise<ProfileRecord> {
    const desiredTiers = new Set(
      profile.visibilityTiers.length > 0
        ? profile.visibilityTiers
        : profile.approvedTier
          ? [profile.approvedTier]
          : []
    );
    const nextPublishedPostIds: Partial<Record<Tier, string>> = { ...profile.publishedPostIds };

    for (const tier of PROFILE_TIERS) {
      const existingThreadId = nextPublishedPostIds[tier];

      if (desiredTiers.has(tier)) {
        nextPublishedPostIds[tier] = await this.upsertPublicProfileThread(member, profile, tier, existingThreadId);
        continue;
      }

      if (existingThreadId) {
        const thread = await this.client.channels.fetch(existingThreadId).catch(() => null);
        if (thread?.isThread()) {
          await thread.delete();
        }
        delete nextPublishedPostIds[tier];
      }
    }

    return this.store.mutate((draft) => {
      const existing = draft.profiles.find((item) => item.id === profile.id);
      if (!existing) {
        throw new Error(`Profile ${profile.id} was not found after sync.`);
      }

      existing.publishedPostIds = nextPublishedPostIds;
      existing.updatedAt = nowIso();
      return structuredClone(existing);
    });
  }

  private async upsertPublicProfileThread(
    member: GuildMember,
    profile: ProfileRecord,
    tier: Tier,
    existingThreadId?: string
  ): Promise<string> {
    const channel = await this.client.channels.fetch(this.appConfig.forums.talent[tier]);
    if (!channel || channel.type !== ChannelType.GuildForum) {
      throw new Error(`Talent forum for ${tier} is missing or invalid.`);
    }

    const forum = channel as ForumChannel;
    const content = this.renderProfileCard(member, profile, tier);
    const title = `${member.displayName} | ${profile.headline}`;

    if (existingThreadId) {
      const thread = await this.client.channels.fetch(existingThreadId).catch(() => null);
      if (thread?.isThread()) {
        if (thread.archived) {
          await thread.setArchived(false);
        }
        const starterMessage = await thread.fetchStarterMessage().catch(() => null);
        if (starterMessage) {
          await starterMessage.edit({ content });
        }
        await thread.setName(title);
        if (!thread.locked) {
          await thread.setLocked(true);
        }
        return thread.id;
      }
    }

    const created = await forum.threads.create({
      name: title,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      message: { content }
    });
    await created.setLocked(true);

    return created.id;
  }

  private renderProfileCard(member: GuildMember, profile: ProfileRecord, tier: Tier): string {
    const skills = profile.skills.length > 0 ? profile.skills.map((skill) => `\`${skill}\``).join(" ") : "N/A";
    const links =
      profile.portfolioLinks.length > 0
        ? profile.portfolioLinks.map((link) => `- ${link}`).join("\n")
        : "- none";
    const stars = profile.moderatorStars > 0 ? "★".repeat(profile.moderatorStars) : "none";
    const memberSince = this.formatMemberSince(profile.networkRegisteredAt || profile.createdAt);
    const clientRating = this.formatAverageStars(profile.feedbackAverage, profile.feedbackCount);

    return [
      `# ${member.displayName}`,
      "",
      `**Talent:** <@${profile.userId}>`,
      `**Title:** ${profile.headline}`,
      `**Network:** ${this.getTierLabel(tier)}`,
      `**Trust Score:** ${profile.trustScore}`,
      `**Moderator Stars:** ${stars}`,
      `**Completed Contracts:** ${profile.completedContracts}`,
      `**Stopped Contracts:** ${profile.stoppedContracts}`,
      `**Disputes:** ${profile.disputeCount}`,
      `**Client Rating:** ${clientRating}`,
      `**Member Since:** ${memberSince}`,
      `**Skills:** ${skills}`,
      "",
      "## Summary",
      profile.bio,
      "",
      "## Previous Projects",
      profile.previousProjects || "N/A",
      "",
      "## Links",
      links
    ].join("\n");
  }

  private async postFeedbackToPublishedThreads(profile: ProfileRecord, feedback: FeedbackRecord): Promise<void> {
    const content = this.renderFeedbackMessage(feedback);
    const threadIds = [...new Set(Object.values(profile.publishedPostIds).filter(Boolean))];

    await Promise.all(
      threadIds.map(async (threadId) => {
        const thread = await this.client.channels.fetch(threadId).catch(() => null);
        if (thread?.isThread()) {
          await thread.send({ content });
        }
      })
    );
  }

  private renderFeedbackMessage(feedback: FeedbackRecord): string {
    const outcome = feedback.outcome === "completed" ? "Success" : "Fail";
    const date = this.formatMemberSince(feedback.createdAt);
    const message = feedback.message.trim();

    return [
      "## Client Feedback",
      `**Job:** ${feedback.jobTitle}`,
      `**Status:** ${outcome}`,
      `**Client:** <@${feedback.clientUserId}>`,
      `**Date:** ${date}`,
      `**Rating:** ${this.formatScoreStars(feedback.score)}`,
      ...(message ? ["", "### Feedback", message] : [])
    ].join("\n");
  }

  private getTierLabel(tier: Tier): string {
    switch (tier) {
      case "gold":
        return "Gold";
      case "silver":
        return "Silver";
      case "copper":
        return "Copper";
    }
  }

  private formatMemberSince(value: string): string {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return "N/A";
    }

    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric"
    }).format(parsed);
  }

  private formatScoreStars(score: number): string {
    const safeScore = Math.max(1, Math.min(5, Math.round(score)));
  
    return `${this.EMOJIS.full.repeat(safeScore)}${this.EMOJIS.empty.repeat(5 - safeScore)} ${safeScore}/5`;
  }
  
  private formatAverageStars(average: number, count: number): string {
    if (count === 0) {
      return "N/A";
    }
  
    // round to nearest 0.5
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
}
