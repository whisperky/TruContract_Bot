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
import type { ProfileRecord, Tier } from "../domain/models.js";
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

  async recordContractOutcome(member: GuildMember, outcome: "completed" | "stopped"): Promise<ProfileRecord | null> {
    const profile = await this.store.mutate((draft) => {
      const existing = draft.profiles.find((item) => item.userId === member.id);
      if (!existing) {
        return null;
      }

      if (outcome === "completed") {
        existing.completedContracts += 1;
      } else {
        existing.stoppedContracts += 1;
      }

      existing.updatedAt = nowIso();
      return structuredClone(existing);
    });

    if (!profile) {
      return null;
    }

    return this.syncPublishedProfile(member, profile);
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
        const starterMessage = await thread.fetchStarterMessage().catch(() => null);
        if (starterMessage) {
          await starterMessage.edit({ content });
        }
        await thread.setName(title);
        return thread.id;
      }
    }

    const created = await forum.threads.create({
      name: title,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      message: { content }
    });

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
}
