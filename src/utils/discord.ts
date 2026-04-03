import {
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type OverwriteResolvable
} from "discord.js";

import type { AppConfig } from "../config.js";

export function isStaff(member: GuildMember, appConfig: AppConfig): boolean {
  return appConfig.staffRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

export function privateChannelOverwrites(
  guild: Guild,
  participantIds: string[],
  appConfig: AppConfig
): OverwriteResolvable[] {
  const uniqueParticipantIds = [...new Set(participantIds)];

  return [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    ...uniqueParticipantIds.map((participantId) => ({
      id: participantId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks
      ]
    })),
    ...appConfig.staffRoleIds.map((roleId) => ({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks
      ]
    }))
  ];
}
