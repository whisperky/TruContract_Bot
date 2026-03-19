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
    namePrefix: string,
    extra: {
      relatedJobId?: string;
      relatedApplicationId?: string;
    } = {}
  ): Promise<TicketRecord> {
    const ticket = await this.store.mutate((draft) => {
      draft.counters.ticket += 1;
      const created: TicketRecord = {
        id: formatExternalId("TKT", draft.counters.ticket),
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
      name: `${namePrefix}-${ticket.id.toLowerCase()}`,
      type: ChannelType.GuildText,
      parent: parent.id,
      permissionOverwrites: privateChannelOverwrites(guild, ownerId, this.appConfig),
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
}
