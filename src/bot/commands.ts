import {
  DiscordAPIError,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";

import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";

export const slashCommands = [
  new SlashCommandBuilder()
    .setName("deploy-panels")
    .setDescription("Deploy the client, developer, and safety desk panels.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName("access-set")
    .setDescription("Set a member's private marketplace access and neutral network tier.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((option) =>
      option.setName("user").setDescription("Server member").setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("access")
        .setDescription("Which marketplace identity this member should have")
        .setRequired(true)
        .addChoices(
          { name: "Client", value: "client" },
          { name: "Developer", value: "developer" },
          { name: "Both", value: "both" },
          { name: "Revoke", value: "revoke" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("tier")
        .setDescription("Neutral network tier to assign")
        .setRequired(false)
        .addChoices(
          { name: "Gold", value: "gold" },
          { name: "Silver", value: "silver" },
          { name: "Copper", value: "copper" }
        )
    ),
  new SlashCommandBuilder()
    .setName("profile-approve")
    .setDescription("Review a developer profile, update trust, and sync it to the right talent forum.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((option) =>
      option.setName("user").setDescription("Developer user").setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("tier")
        .setDescription("Talent tier to publish the profile into")
        .setRequired(true)
        .addChoices(
          { name: "Gold", value: "gold" },
          { name: "Silver", value: "silver" },
          { name: "Copper", value: "copper" }
        )
    )
    .addIntegerOption((option) =>
      option
        .setName("stars")
        .setDescription("Moderator stars from 0 to 3")
        .setMinValue(0)
        .setMaxValue(3)
        .setRequired(false)
    )
    .addIntegerOption((option) =>
      option
        .setName("score")
        .setDescription("Trust score from 0 to 100")
        .setMinValue(0)
        .setMaxValue(100)
        .setRequired(false)
    )
    .addIntegerOption((option) =>
      option
        .setName("disputes")
        .setDescription("Total disputes or safety issues for this profile")
        .setMinValue(0)
        .setMaxValue(100)
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("tier-counts-sync")
    .setDescription("Refresh network tier member count channels.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName("profile-resume")
    .setDescription("Upload or replace your developer resume file.")
    .addAttachmentOption((option) =>
      option
        .setName("file")
        .setDescription("Resume file (PDF preferred)")
        .setRequired(true)
    )
].map((command) => command.toJSON());

export async function registerCommands(appConfig: AppConfig): Promise<boolean> {
  const rest = new REST({ version: "10" }).setToken(appConfig.token);
  try {
    await rest.put(Routes.applicationGuildCommands(appConfig.clientId, appConfig.guildId), {
      body: slashCommands
    });
    return true;
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === 50_001) {
      logger.warn("Skipping slash command registration because Discord denied access to the configured guild.", {
        guildId: appConfig.guildId,
        clientId: appConfig.clientId,
        hint: "Confirm DISCORD_GUILD_ID is correct and invite the app with the applications.commands scope."
      });
      return false;
    }

    throw error;
  }
}
