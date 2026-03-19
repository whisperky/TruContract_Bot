import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} from "discord.js";

export function buildSafetyDeskEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Safety Desk")
    .setDescription(
      [
        "Open a private safety case.",
        "Use this for scam reports, abuse reports, and privacy concerns.",
        "The bot will create a private room only visible to you and staff."
      ].join("\n")
    )
    .setColor(0xd7263d);
}

export function buildSafetyDeskComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("desk|report")
        .setLabel("Open Safety Case")
        .setStyle(ButtonStyle.Danger)
    )
  ];
}
