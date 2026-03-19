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

export class ProfileService {
  constructor(
    private readonly client: Client,
    private readonly store: JsonStore,
    private readonly appConfig: AppConfig
  ) {}

  async upsertProfile(
    userId: string,
    payload: {
      headline: string;
      bio: string;
      skills: string[];
      portfolioLinks: string[];
      availability: string;
      privateChannelId?: string;
    }
  ): Promise<ProfileRecord> {
    return this.store.mutate((draft) => {
      const now = nowIso();
      const existing = draft.profiles.find((profile) => profile.userId === userId);

      if (existing) {
        existing.headline = payload.headline;
        existing.bio = payload.bio;
        existing.skills = payload.skills;
        existing.portfolioLinks = payload.portfolioLinks;
        existing.availability = payload.availability;
        if (payload.privateChannelId) {
          existing.privateChannelId = payload.privateChannelId;
        }
        existing.status = "pending";
        existing.updatedAt = now;
        return existing;
      }

      draft.counters.profile += 1;
      const created: ProfileRecord = {
        id: formatExternalId("PRO", draft.counters.profile),
        userId,
        headline: payload.headline,
        bio: payload.bio,
        skills: payload.skills,
        portfolioLinks: payload.portfolioLinks,
        availability: payload.availability,
        trustScore: 50,
        moderatorStars: 0,
        status: "pending",
        publishedPostIds: {},
        createdAt: now,
        updatedAt: now
      };

      if (payload.privateChannelId) {
        created.privateChannelId = payload.privateChannelId;
      }

      draft.profiles.push(created);
      return created;
    });
  }

  async approveProfile(
    member: GuildMember,
    tier: Tier,
    stars: number,
    trustScore: number
  ): Promise<ProfileRecord> {
    const profile = await this.store.mutate((draft) => {
      const existing = draft.profiles.find((item) => item.userId === member.id);
      if (!existing) {
        throw new Error("Profile not found for that user.");
      }

      existing.status = "approved";
      existing.approvedTier = tier;
      existing.moderatorStars = stars;
      existing.trustScore = trustScore;
      existing.updatedAt = nowIso();
      return existing;
    });

    await this.publishProfile(member, profile, tier);
    return profile;
  }

  buildDeskEmbed(): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle("Developer Desk")
      .setDescription(
        [
          "Create or update your private developer profile.",
          "Profiles stay private until staff approves and publishes the official forum post.",
          "Applications to jobs stay private."
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

  private async publishProfile(member: GuildMember, profile: ProfileRecord, tier: Tier): Promise<string> {
    const channel = await this.client.channels.fetch(this.appConfig.forums.talent[tier]);
    if (!channel || channel.type !== ChannelType.GuildForum) {
      throw new Error(`Talent forum for ${tier} is missing or invalid.`);
    }

    const forum = channel as ForumChannel;
    const content = this.renderProfileCard(member, profile);
    const title = `${member.displayName} • ${profile.headline}`;
    const existingThreadId = profile.publishedPostIds[tier];

    let threadId: string;

    if (existingThreadId) {
      const thread = await this.client.channels.fetch(existingThreadId).catch(() => null);
      if (thread?.isThread()) {
        const starterMessage = await thread.fetchStarterMessage().catch(() => null);
        if (starterMessage) {
          await starterMessage.edit({ content });
        }
        await thread.setName(title);
        threadId = thread.id;
      } else {
        const created = await forum.threads.create({
          name: title,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
          message: { content }
        });
        threadId = created.id;
      }
    } else {
      const created = await forum.threads.create({
        name: title,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        message: { content }
      });
      threadId = created.id;
    }

    await this.store.mutate((draft) => {
      const existing = draft.profiles.find((item) => item.id === profile.id);
      if (existing) {
        existing.status = "approved";
        existing.approvedTier = tier;
        existing.publishedPostIds[tier] = threadId;
        existing.updatedAt = nowIso();
      }
    });

    return threadId;
  }

  private renderProfileCard(member: GuildMember, profile: ProfileRecord): string {
    const stars = "★".repeat(profile.moderatorStars) || "pending";
    const links =
      profile.portfolioLinks.length > 0
        ? profile.portfolioLinks.map((link) => `- ${link}`).join("\n")
        : "- none";
    const skills = profile.skills.length > 0 ? profile.skills.join(", ") : "none";

    return [
      `# ${member.displayName}`,
      "",
      `**Headline:** ${profile.headline}`,
      `**Availability:** ${profile.availability}`,
      `**Skills:** ${skills}`,
      `**Moderator Stars:** ${stars}`,
      `**Trust Score:** ${profile.trustScore}`,
      "",
      "## Bio",
      profile.bio,
      "",
      "## Portfolio",
      links,
      "",
      "_This profile is authored and updated by the Trust Contract bot._"
    ].join("\n");
  }
}
