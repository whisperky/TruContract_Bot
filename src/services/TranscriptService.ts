import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { AttachmentBuilder, ChannelType, type Client, type Guild, type Message, type TextChannel } from "discord.js";

import type { AppConfig } from "../config.js";
import type { ApplicationRecord, JobRecord } from "../domain/models.js";
import { nowIso } from "../utils/id.js";

const MAX_ATTACHMENT_BYTES = 7_500_000;

type TranscriptArtifact = {
  attachment: AttachmentBuilder;
  byteLength: number;
  filePath: string;
  filename: string;
};

type TranscriptSection = {
  channelId: string;
  heading: string;
  metadata: string[];
};

export class TranscriptService {
  private readonly exportDir: string;

  constructor(
    private readonly client: Client,
    appConfig: AppConfig
  ) {
    this.exportDir = path.resolve(path.dirname(appConfig.storeFile), "transcripts");
  }

  async exportApplicationTranscript(
    guild: Guild,
    job: JobRecord,
    application: ApplicationRecord,
    outcome: "completed" | "stopped",
    score: number,
    feedbackMessage: string
  ): Promise<TranscriptArtifact> {
    if (!application.privateChannelId) {
      throw new Error("This contract room is not available for transcript export.");
    }

    return this.buildTranscriptArtifact(
      this.buildFileName(job.id, `${application.id}-${outcome}`),
      [
        `Trust Contract Transcript Export`,
        `Generated At: ${nowIso()}`,
        `Guild: ${guild.name}`,
        `Job: ${job.id} - ${job.title}`,
        `Application: ${application.id}`,
        `Outcome: ${outcome}`,
        `Feedback Score: ${score}/5`,
        `Feedback Message: ${feedbackMessage || "(empty)"}`
      ],
      [
        {
          channelId: application.privateChannelId,
          heading: `Contract Room ${application.id}`,
          metadata: [
            `Developer: ${application.devUserId}`,
            `Entry: ${application.origin}`,
            `Status Before Cleanup: ${application.status}`
          ]
        }
      ]
    );
  }

  async exportJobClosureArchive(
    guild: Guild,
    job: JobRecord,
    applications: ApplicationRecord[],
    completedApplication: ApplicationRecord,
    score: number,
    feedbackMessage: string
  ): Promise<TranscriptArtifact> {
    const sections: TranscriptSection[] = [];

    if (job.privateChannelId) {
      sections.push({
        channelId: job.privateChannelId,
        heading: `Job Room ${job.id}`,
        metadata: [`Client: ${job.clientId}`, `Market: ${job.marketTier}`, `Status Before Cleanup: ${job.status}`]
      });
    }

    for (const application of applications) {
      if (!application.privateChannelId) {
        continue;
      }

      sections.push({
        channelId: application.privateChannelId,
        heading: `Application Room ${application.id}`,
        metadata: [
          `Developer: ${application.devUserId}`,
          `Entry: ${application.origin}`,
          `Status Before Cleanup: ${application.status}`
        ]
      });
    }

    if (sections.length === 0) {
      throw new Error("No private channels were available to export for this job.");
    }

    return this.buildTranscriptArtifact(
      this.buildFileName(job.id, "closure-archive"),
      [
        `Trust Contract Job Archive Export`,
        `Generated At: ${nowIso()}`,
        `Guild: ${guild.name}`,
        `Job: ${job.id} - ${job.title}`,
        `Final Outcome: completed`,
        `Completed Application: ${completedApplication.id}`,
        `Feedback Score: ${score}/5`,
        `Feedback Message: ${feedbackMessage || "(empty)"}`
      ],
      sections
    );
  }

  private async buildTranscriptArtifact(
    filename: string,
    headerLines: string[],
    sections: TranscriptSection[]
  ): Promise<TranscriptArtifact> {
    const renderedSections = await Promise.all(sections.map((section) => this.renderSection(section)));
    const hasAvailableSection = renderedSections.some((section) => section.available);
    if (!hasAvailableSection) {
      throw new Error("Transcript export failed because none of the channels could be read.");
    }

    const content = [
      ...headerLines,
      "",
      ...renderedSections.flatMap((section) => ["=".repeat(80), ...section.lines, ""])
    ].join("\n");

    const byteLength = Buffer.byteLength(content, "utf8");
    if (byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error("Transcript is too large to export as a Discord attachment. Finalize again without export.");
    }

    await mkdir(this.exportDir, { recursive: true });
    const filePath = path.join(this.exportDir, filename);
    await writeFile(filePath, content, "utf8");

    return {
      attachment: new AttachmentBuilder(Buffer.from(content, "utf8"), { name: filename }),
      byteLength,
      filePath,
      filename
    };
  }

  private async renderSection(section: TranscriptSection): Promise<{ available: boolean; lines: string[] }> {
    const channel = await this.fetchTextChannel(section.channelId);
    if (!channel) {
      return {
        available: false,
        lines: [
          `# ${section.heading}`,
          `Channel Id: ${section.channelId}`,
          ...section.metadata,
          "Status: unavailable"
        ]
      };
    }

    const messages = await this.fetchAllMessages(channel);
    const lines = [
      `# ${section.heading}`,
      `Channel: #${channel.name} (${channel.id})`,
      ...section.metadata,
      `Messages: ${messages.length}`,
      ""
    ];

    if (messages.length === 0) {
      lines.push("[No messages found]");
      return { available: true, lines };
    }

    for (const message of messages) {
      lines.push(...this.formatMessage(message), "");
    }

    return { available: true, lines };
  }

  private async fetchTextChannel(channelId: string): Promise<TextChannel | null> {
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased() || channel.type !== ChannelType.GuildText) {
      return null;
    }

    return channel as TextChannel;
  }

  private async fetchAllMessages(channel: TextChannel): Promise<Message[]> {
    const messages: Message[] = [];
    let before: string | undefined;

    while (true) {
      const fetchOptions: { limit: number; before?: string } = { limit: 100 };
      if (before) {
        fetchOptions.before = before;
      }

      const batch = await channel.messages.fetch(fetchOptions).catch(() => null);
      if (!batch || batch.size === 0) {
        break;
      }

      const items = [...batch.values()];
      messages.push(...items);
      before = items.at(-1)?.id;

      if (batch.size < 100) {
        break;
      }
    }

    return messages.reverse();
  }

  private formatMessage(message: Message): string[] {
    const authorName = message.member?.displayName ?? message.author.globalName ?? message.author.username;

    const lines = [`[${message.createdAt.toISOString()}] ${authorName} (${message.author.id})`];

    const normalizedContent = message.content.trim();
    if (normalizedContent) {
      lines.push(...normalizedContent.split(/\r?\n/));
    }

    for (const attachment of message.attachments.values()) {
      lines.push(`[attachment] ${attachment.name ?? "file"}: ${attachment.url}`);
    }

    for (const embed of message.embeds) {
      const parts = [embed.title, embed.description].filter(Boolean);
      if (parts.length > 0) {
        lines.push(`[embed] ${parts.join(" | ")}`);
      } else {
        lines.push("[embed]");
      }
    }

    if (message.stickers.size > 0) {
      for (const sticker of message.stickers.values()) {
        lines.push(`[sticker] ${sticker.name}`);
      }
    }

    if (
      !normalizedContent &&
      message.attachments.size === 0 &&
      message.embeds.length === 0 &&
      message.stickers.size === 0
    ) {
      lines.push("[no text content]");
    }

    return lines;
  }

  private buildFileName(jobId: string, suffix: string): string {
    const timestamp = nowIso().replace(/[:.]/g, "-");
    return `${this.slugify(jobId)}-${this.slugify(suffix)}-${timestamp}.txt`;
  }

  private slugify(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
}
