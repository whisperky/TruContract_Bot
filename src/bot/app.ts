import {
  ActionRowBuilder,
  ButtonBuilder,
  Client,
  Events,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type TextChannel
} from "discord.js";

import type { AppConfig } from "../config.js";
import type { Tier } from "../domain/models.js";
import { logger } from "../logger.js";
import { JobService } from "../services/JobService.js";
import { ProfileService } from "../services/ProfileService.js";
import { TicketService } from "../services/TicketService.js";
import { JsonStore } from "../storage/JsonStore.js";
import {
  getClientAllowedPublishTiers,
  getDevTier,
  isStaff
} from "../utils/discord.js";
import { buildSafetyDeskComponents, buildSafetyDeskEmbed } from "./panels.js";

export class TrustContractBot {
  readonly client: Client;
  private readonly tickets: TicketService;
  private readonly profiles: ProfileService;
  private readonly jobs: JobService;

  constructor(
    private readonly appConfig: AppConfig,
    store: JsonStore
  ) {
    this.client = new Client({
      intents: ["Guilds"]
    });

    this.tickets = new TicketService(this.client, store, appConfig);
    this.profiles = new ProfileService(this.client, store, appConfig);
    this.jobs = new JobService(this.client, store, appConfig);
  }

  start(): void {
    this.client.once(Events.ClientReady, (readyClient) => {
      logger.info(`Logged in as ${readyClient.user.tag}`);
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      try {
        if (interaction.isChatInputCommand()) {
          await this.handleCommand(interaction);
          return;
        }

        if (interaction.isButton()) {
          await this.handleButton(interaction);
          return;
        }

        if (interaction.isModalSubmit()) {
          await this.handleModal(interaction);
        }
      } catch (error) {
        logger.error("Interaction handler failed", {
          error: error instanceof Error ? error.message : String(error),
          interactionId: interaction.id
        });

        const reply = {
          content: "Something went wrong while handling that action.",
          ephemeral: true
        };

        if (interaction.isRepliable()) {
          if (interaction.deferred || interaction.replied) {
            await interaction.followUp(reply).catch(() => undefined);
          } else {
            await interaction.reply(reply).catch(() => undefined);
          }
        }
      }
    });
  }

  async login(): Promise<void> {
    await this.client.login(this.appConfig.token);
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: "This command can only be used inside the server.",
        ephemeral: true
      });
      return;
    }

    const guild = interaction.guild ?? (await this.client.guilds.fetch(interaction.guildId));
    switch (interaction.commandName) {
      case "deploy-panels":
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          await interaction.reply({
            content: "You do not have permission to deploy panels.",
            ephemeral: true
          });
          return;
        }

        await this.deployPanels();
        await interaction.reply({
          content: "Desk panels deployed.",
          ephemeral: true
        });
        return;

      case "profile-approve": {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          await interaction.reply({
            content: "You do not have permission to approve profiles.",
            ephemeral: true
          });
          return;
        }

        const user = interaction.options.getUser("user", true);
        const tier = interaction.options.getString("tier", true) as Tier;
        const stars = interaction.options.getInteger("stars") ?? 2;
        const score = interaction.options.getInteger("score") ?? 70;
        const guildMember = await guild.members.fetch(user.id);
        const profile = await this.profiles.approveProfile(guildMember, tier, stars, score);
        await interaction.reply({
          content: `Approved ${user} as ${tier}. Profile ${profile.id} published.`,
          ephemeral: true
        });
        return;
      }

      default:
        await interaction.reply({
          content: "Unknown command.",
          ephemeral: true
        });
    }
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: "This action can only be used inside the server.",
        ephemeral: true
      });
      return;
    }

    const guild = interaction.guild ?? (await this.client.guilds.fetch(interaction.guildId));
    const member = await guild.members.fetch(interaction.user.id);
    const [scope, action, entityId, extra] = interaction.customId.split("|");

    if (scope === "desk" && action === "new_job") {
      await interaction.showModal(buildNewJobModal());
      return;
    }

    if (scope === "desk" && action === "my_jobs") {
      const jobs = await this.jobs.listJobsByClient(interaction.user.id);
      const content =
        jobs.length === 0
          ? "You do not have any jobs yet."
          : jobs.map((job) => `${job.id} • ${job.title} • ${job.status}`).join("\n");
      await interaction.reply({
        content,
        ephemeral: true
      });
      return;
    }

    if (scope === "desk" && action === "dev_profile") {
      await interaction.showModal(buildDeveloperProfileModal());
      return;
    }

    if (scope === "desk" && action === "my_applications") {
      const applications = await this.jobs.listApplicationsByDeveloper(interaction.user.id);
      const content =
        applications.length === 0
          ? "You do not have any applications yet."
          : applications
              .map((application) => `${application.id} • ${application.jobId} • ${application.status}`)
              .join("\n");
      await interaction.reply({
        content,
        ephemeral: true
      });
      return;
    }

    if (scope === "desk" && action === "report") {
      await interaction.showModal(buildSafetyModal());
      return;
    }

    if (scope === "job" && action === "publish" && entityId && extra) {
      const tier = extra as Tier;
      const allowedTiers = isStaff(member, this.appConfig)
        ? (["gold", "silver", "copper"] as Tier[])
        : getClientAllowedPublishTiers(member, this.appConfig);

      if (!allowedTiers.includes(tier)) {
        await interaction.reply({
          content: `You are not allowed to publish jobs into the ${tier} feed.`,
          ephemeral: true
        });
        return;
      }

      const threadId = await this.jobs.publishJob(entityId, tier);
      await interaction.reply({
        content: `Published ${entityId} to ${tier}. Public thread ID: ${threadId}`,
        ephemeral: true
      });
      return;
    }

    if (scope === "job" && action === "shortlist" && entityId) {
      const job = await this.jobs.getJob(entityId);
      if (!job) {
        await interaction.reply({
          content: `Job ${entityId} was not found.`,
          ephemeral: true
        });
        return;
      }

      if (!isStaff(member, this.appConfig) && interaction.user.id !== job.clientId) {
        await interaction.reply({
          content: "Only the client who owns the job or staff can request the shortlist.",
          ephemeral: true
        });
        return;
      }

      const applications = await this.jobs.shortlist(entityId);
      const room = await this.tickets.fetchTextChannel(job.privateChannelId);
      await room.send(this.jobs.formatShortlist(job, applications));
      await interaction.reply({
        content: `Shortlist generated in ${room}.`,
        ephemeral: true
      });
      return;
    }

    if (scope === "job" && action === "close" && entityId) {
      const job = await this.jobs.getJob(entityId);
      if (!job) {
        await interaction.reply({
          content: `Job ${entityId} was not found.`,
          ephemeral: true
        });
        return;
      }

      if (!isStaff(member, this.appConfig) && interaction.user.id !== job.clientId) {
        await interaction.reply({
          content: "Only the client who owns the job or staff can close it.",
          ephemeral: true
        });
        return;
      }

      await this.jobs.closeJob(entityId);
      const room = await this.tickets.fetchTextChannel(job.privateChannelId);
      await room.send(`Job ${job.id} is now closed.`);
      await interaction.reply({
        content: `Closed ${job.id}.`,
        ephemeral: true
      });
      return;
    }

    if (scope === "job" && action === "apply" && entityId) {
      const tier = getDevTier(member, this.appConfig);
      if (!tier) {
        await interaction.reply({
          content: "You need a developer tier role before you can apply.",
          ephemeral: true
        });
        return;
      }

      await interaction.showModal(buildApplicationModal(entityId));
      return;
    }

    await interaction.reply({
      content: "Unknown button action.",
      ephemeral: true
    });
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: "This action can only be used inside the server.",
        ephemeral: true
      });
      return;
    }

    const guild = interaction.guild ?? (await this.client.guilds.fetch(interaction.guildId));
    const [scope, action, entityId] = interaction.customId.split("|");

    if (scope === "modal" && action === "new_job") {
      const title = interaction.fields.getTextInputValue("job_title").trim();
      const summary = interaction.fields.getTextInputValue("job_summary").trim();
      const skills = interaction.fields.getTextInputValue("job_skills").trim();
      const budget = interaction.fields.getTextInputValue("job_budget").trim();
      const timeline = interaction.fields.getTextInputValue("job_timeline").trim();

      const ticket = await this.tickets.createPrivateTicket(
        guild,
        interaction.user.id,
        "client_job",
        this.appConfig.categoryIds.clientPrivate,
        "job"
      );

      const job = await this.jobs.createJob(interaction.user.id, ticket.channelId, {
        title,
        summary,
        skills: skills
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        budget,
        timeline
      });

      const room = await this.tickets.fetchTextChannel(ticket.channelId);
      await room.send({
        content: this.jobs.renderPrivateJobSummary(job),
        components: this.jobs.buildJobManagementButtons(job.id)
      });

      await interaction.reply({
        content: `Private job room created: ${room}`,
        ephemeral: true
      });
      return;
    }

    if (scope === "modal" && action === "dev_profile") {
      const headline = interaction.fields.getTextInputValue("profile_headline").trim();
      const bio = interaction.fields.getTextInputValue("profile_bio").trim();
      const skills = interaction.fields.getTextInputValue("profile_skills").trim();
      const portfolios = interaction.fields.getTextInputValue("profile_links").trim();
      const availability = interaction.fields.getTextInputValue("profile_availability").trim();

      const ticket = await this.tickets.createPrivateTicket(
        guild,
        interaction.user.id,
        "dev_profile",
        this.appConfig.categoryIds.devPrivate,
        "profile"
      );

      const profile = await this.profiles.upsertProfile(interaction.user.id, {
        headline,
        bio,
        skills: skills
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        portfolioLinks: portfolios
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        availability,
        privateChannelId: ticket.channelId
      });

      const room = await this.tickets.fetchTextChannel(ticket.channelId);
      await room.send(
        [
          `# ${profile.id} profile received`,
          "",
          "Staff will review this private profile submission before anything is published.",
          "",
          `**Headline:** ${profile.headline}`,
          `**Skills:** ${profile.skills.join(", ") || "none"}`,
          `**Availability:** ${profile.availability}`
        ].join("\n")
      );

      await interaction.reply({
        content: `Private profile room created: ${room}`,
        ephemeral: true
      });
      return;
    }

    if (scope === "modal" && action === "safety") {
      const caseType = interaction.fields.getTextInputValue("case_type").trim();
      const details = interaction.fields.getTextInputValue("case_details").trim();

      const ticket = await this.tickets.createPrivateTicket(
        guild,
        interaction.user.id,
        "safety",
        this.appConfig.categoryIds.casePrivate,
        "case"
      );

      const room = await this.tickets.fetchTextChannel(ticket.channelId);
      await room.send(
        [
          `# Safety Case ${ticket.id}`,
          "",
          `**Type:** ${caseType}`,
          "",
          "## Details",
          details
        ].join("\n")
      );

      await interaction.reply({
        content: `Private safety case created: ${room}`,
        ephemeral: true
      });
      return;
    }

    if (scope === "modal" && action === "apply" && entityId) {
      const pitch = interaction.fields.getTextInputValue("app_pitch").trim();
      const matchingSkills = interaction.fields.getTextInputValue("app_skills").trim();
      const rate = interaction.fields.getTextInputValue("app_rate").trim();
      const availability = interaction.fields.getTextInputValue("app_availability").trim();

      const ticket = await this.tickets.createPrivateTicket(
        guild,
        interaction.user.id,
        "dev_application",
        this.appConfig.categoryIds.devPrivate,
        "app",
        { relatedJobId: entityId }
      );

      const application = await this.jobs.createApplication(entityId, interaction.user.id, {
        pitch,
        matchingSkills: matchingSkills
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        rate,
        availability,
        privateChannelId: ticket.channelId
      });

      const room = await this.tickets.fetchTextChannel(ticket.channelId);
      await room.send(
        [
          `# ${application.id} submitted`,
          "",
          `**Job:** ${application.jobId}`,
          `**Rate:** ${application.rate}`,
          `**Availability:** ${application.availability}`,
          "",
          "## Pitch",
          application.pitch
        ].join("\n")
      );

      const job = await this.jobs.getJob(entityId);
      if (job) {
        const clientRoom = await this.tickets.fetchTextChannel(job.privateChannelId);
        await clientRoom.send(
          [
            `New private application received for ${job.id}.`,
            `Developer: <@${interaction.user.id}>`,
            `Application: ${application.id}`
          ].join("\n")
        );
      }

      await interaction.reply({
        content: `Application received. Private room created: ${room}`,
        ephemeral: true
      });
      return;
    }

    await interaction.reply({
      content: "Unknown modal action.",
      ephemeral: true
    });
  }

  private async deployPanels(): Promise<void> {
    const clientDesk = await this.client.channels.fetch(this.appConfig.channelIds.clientDesk);
    const devDesk = await this.client.channels.fetch(this.appConfig.channelIds.devDesk);
    const safetyDesk = await this.client.channels.fetch(this.appConfig.channelIds.safetyDesk);

    if (!clientDesk?.isTextBased() || clientDesk.isDMBased()) {
      throw new Error("Configured client desk channel is invalid.");
    }

    if (!devDesk?.isTextBased() || devDesk.isDMBased()) {
      throw new Error("Configured developer desk channel is invalid.");
    }

    if (!safetyDesk?.isTextBased() || safetyDesk.isDMBased()) {
      throw new Error("Configured safety desk channel is invalid.");
    }

    const clientDeskChannel = clientDesk as TextChannel;
    const devDeskChannel = devDesk as TextChannel;
    const safetyDeskChannel = safetyDesk as TextChannel;

    await clientDeskChannel.send({
      embeds: [this.jobs.buildClientDeskEmbed()],
      components: this.jobs.buildClientDeskComponents()
    });

    await devDeskChannel.send({
      embeds: [this.profiles.buildDeskEmbed()],
      components: this.profiles.buildDeskComponents()
    });

    await safetyDeskChannel.send({
      embeds: [buildSafetyDeskEmbed()],
      components: buildSafetyDeskComponents()
    });
  }
}

function buildNewJobModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("modal|new_job")
    .setTitle("Create Private Job")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("job_title")
          .setLabel("Job Title")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("job_summary")
          .setLabel("Job Summary")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("job_skills")
          .setLabel("Skills (comma separated)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(200)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("job_budget")
          .setLabel("Budget")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("job_timeline")
          .setLabel("Timeline")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
      )
    );
}

function buildDeveloperProfileModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("modal|dev_profile")
    .setTitle("Developer Profile")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("profile_headline")
          .setLabel("Headline")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("profile_bio")
          .setLabel("Short Bio")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("profile_skills")
          .setLabel("Skills (comma separated)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(200)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("profile_links")
          .setLabel("Portfolio Links (comma separated)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(400)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("profile_availability")
          .setLabel("Availability")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
      )
    );
}

function buildSafetyModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("modal|safety")
    .setTitle("Open Safety Case")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("case_type")
          .setLabel("Case Type")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("case_details")
          .setLabel("Details")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1500)
      )
    );
}

function buildApplicationModal(jobId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`modal|apply|${jobId}`)
    .setTitle(`Apply to ${jobId}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("app_pitch")
          .setLabel("Short Pitch")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("app_skills")
          .setLabel("Matching Skills (comma separated)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(200)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("app_rate")
          .setLabel("Rate / Pricing")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("app_availability")
          .setLabel("Availability")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
      )
    );
}
