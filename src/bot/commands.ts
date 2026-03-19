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
    .setName("profile-approve")
    .setDescription("Approve a developer profile and publish it to a talent forum.")
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
