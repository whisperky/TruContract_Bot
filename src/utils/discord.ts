import {
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type OverwriteResolvable
} from "discord.js";

import type { AppConfig } from "../config.js";
import type { Tier } from "../domain/models.js";

export function isStaff(member: GuildMember, appConfig: AppConfig): boolean {
  return appConfig.staffRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

export function getClientAllowedPublishTiers(
  member: GuildMember,
  appConfig: AppConfig
): Tier[] {
  if (member.roles.cache.has(appConfig.roleIds.client.gold)) {
    return ["gold", "silver", "copper"];
  }

  if (member.roles.cache.has(appConfig.roleIds.client.silver)) {
    return ["silver", "copper"];
  }

  if (member.roles.cache.has(appConfig.roleIds.client.copper)) {
    return ["copper"];
  }

  return [];
}

export function getDevTier(member: GuildMember, appConfig: AppConfig): Tier | null {
  if (member.roles.cache.has(appConfig.roleIds.dev.gold)) {
    return "gold";
  }

  if (member.roles.cache.has(appConfig.roleIds.dev.silver)) {
    return "silver";
  }

  if (member.roles.cache.has(appConfig.roleIds.dev.copper)) {
    return "copper";
  }

  return null;
}

export function privateChannelOverwrites(
  guild: Guild,
  ownerId: string,
  appConfig: AppConfig
): OverwriteResolvable[] {
  return [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      id: ownerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks
      ]
    },
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
