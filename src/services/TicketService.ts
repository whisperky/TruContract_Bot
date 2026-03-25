import {
  ChannelType,
  type Client,
  type Guild,
  type TextChannel
} from "discord.js";

import type { AppConfig } from "../config.js";
import type { TicketKind, TicketRecord } from "../domain/models.js";
import { JsonStore } from "../storage/JsonStore.js";
import { privateChannelOverwrites } from "../utils/discord.js";
import { formatExternalId, nowIso } from "../utils/id.js";

const TICKET_ID_PREFIXES: Record<TicketKind, string> = {
  client_job: "JOB-TKT",
  client_support: "SUP-TKT",
  dev_profile: "PRO-TKT",
  dev_application: "APP-TKT",
  safety: "CASE-TKT"
};

export class TicketService {
  constructor(
    private readonly client: Client,
    private readonly store: JsonStore,
    private readonly appConfig: AppConfig
  ) {}

  async createPrivateTicket(
    guild: Guild,
    ownerId: string,
    kind: TicketKind,
    parentCategoryId: string,
    extra: {
      relatedJobId?: string;
      relatedApplicationId?: string;
      participantIds?: string[];
    } = {}
  ): Promise<TicketRecord> {
    const participantIds = extra.participantIds ?? [ownerId];

    const ticket = await this.store.mutate((draft) => {
      draft.counters.ticket += 1;
      draft.counters.ticketByKind[kind] += 1;
      const created: TicketRecord = {
        id: formatExternalId(TICKET_ID_PREFIXES[kind], draft.counters.ticketByKind[kind]),
        kind,
        ownerId,
        channelId: "",
        createdAt: nowIso()
      };

      if (extra.relatedJobId) {
        created.relatedJobId = extra.relatedJobId;
      }

      if (extra.relatedApplicationId) {
        created.relatedApplicationId = extra.relatedApplicationId;
      }

      draft.tickets.push(created);
      return created;
    });

    const parent = await guild.channels.fetch(parentCategoryId);
    if (!parent || parent.type !== ChannelType.GuildCategory) {
      throw new Error(`Category ${parentCategoryId} is missing or invalid.`);
    }

    const channel = await guild.channels.create({
      name: ticket.id.toLowerCase(),
      type: ChannelType.GuildText,
      parent: parent.id,
      permissionOverwrites: privateChannelOverwrites(guild, participantIds, this.appConfig),
      topic: `Private ${kind} ticket ${ticket.id}`
    });

    await this.store.mutate((draft) => {
      const existing = draft.tickets.find((item) => item.id === ticket.id);
      if (existing) {
        existing.channelId = channel.id;
      }
    });

    return {
      ...ticket,
      channelId: channel.id
    };
  }

  async fetchTextChannel(channelId: string): Promise<TextChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(`Channel ${channelId} is not a guild text channel.`);
    }

    return channel;
  }

  async lockTextChannel(channelId: string, participantIds: string[]): Promise<void> {
    const channel = await this.fetchTextChannel(channelId);
    const uniqueParticipantIds = [...new Set(participantIds)];

    await Promise.all(
      uniqueParticipantIds.map((participantId) =>
        channel.permissionOverwrites.edit(participantId, {
          ViewChannel: true,
          ReadMessageHistory: true,
          SendMessages: false,
          AttachFiles: false,
          EmbedLinks: false,
          AddReactions: false
        })
      )
    );

    await channel.permissionOverwrites.edit(channel.guild.roles.everyone.id, {
      ViewChannel: false
    });
  }
}
