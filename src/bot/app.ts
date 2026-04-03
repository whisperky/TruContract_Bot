import {
  ActionRowBuilder,
  ButtonBuilder,
  Client,
  Events,
  type Guild,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
  type TextChannel
} from "discord.js";

import type { AppConfig } from "../config.js";
import type { AccountKind, ApplicationRecord, JobRecord, ProfileRecord, Tier } from "../domain/models.js";
import { logger } from "../logger.js";
import { AccessService } from "../services/AccessService.js";
import { JobService } from "../services/JobService.js";
import { ProfileService } from "../services/ProfileService.js";
import { TicketService } from "../services/TicketService.js";
import { JsonStore } from "../storage/JsonStore.js";
import { isStaff } from "../utils/discord.js";
import { buildSafetyDeskComponents, buildSafetyDeskEmbed } from "./panels.js";

export class TrustContractBot {
  readonly client: Client;
  private readonly tickets: TicketService;
  private readonly access: AccessService;
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
    this.access = new AccessService(store, appConfig);
    this.profiles = new ProfileService(this.client, store, appConfig, this.access);
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

  private EMOJIS = {
    full: "<:star_full:1488689485720981534>",
    half: "<:star_half:1488689511104905216>",
    empty: "<:star_empty:1488689461893140480>",
  };

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

        await interaction.deferReply({ ephemeral: true });
        await this.deployPanels();
        await interaction.editReply("Desk panels deployed.");
        return;

      case "access-set": {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          await interaction.reply({
            content: "You do not have permission to manage marketplace access.",
            ephemeral: true
          });
          return;
        }

        await interaction.deferReply({ ephemeral: true });
        const user = interaction.options.getUser("user", true);
        const access = interaction.options.getString("access", true);
        const tier = interaction.options.getString("tier") as Tier | null;
        const guildMember = await guild.members.fetch(user.id);
        const requestedKinds = this.parseAccessKinds(access);

        if (requestedKinds.length > 0 && !tier) {
          await interaction.editReply("A network tier is required unless you are revoking access.");
          return;
        }

        const accessPayload: {
          kinds: AccountKind[];
          tier?: Tier;
          updatedBy: string;
        } = {
          kinds: requestedKinds,
          updatedBy: interaction.user.id
        };
        if (tier) {
          accessPayload.tier = tier;
        }

        const record = await this.access.setAccess(guildMember, accessPayload);

        if (!record) {
          await interaction.editReply(`Revoked marketplace access for ${user}.`);
          return;
        }

        await interaction.editReply(
          `Updated ${user}: ${record.kinds.join(" + ")} on ${record.tier}. Neutral network role synced.`
        );
        return;
      }

      case "profile-approve": {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          await interaction.reply({
            content: "You do not have permission to approve profiles.",
            ephemeral: true
          });
          return;
        }

        await interaction.deferReply({ ephemeral: true });
        const user = interaction.options.getUser("user", true);
        const tier = interaction.options.getString("tier", true) as Tier;
        const stars = interaction.options.getInteger("stars") ?? 2;
        const score = interaction.options.getInteger("score") ?? 70;
        const disputes = interaction.options.getInteger("disputes") ?? undefined;
        const guildMember = await guild.members.fetch(user.id);
        const profile = await this.profiles.approveProfile(guildMember, tier, stars, score, disputes);
        await this.access.ensureKindsAndTier(guildMember, {
          requiredKinds: ["developer"],
          tier,
          updatedBy: interaction.user.id
        });
        await interaction.editReply(`Approved ${user} as ${tier}. Profile ${profile.id} published.`);
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
    const deskTier = this.parseTier(entityId);

    if (scope === "desk" && action === "new_job") {
      if (!deskTier || !(await this.access.canAccessMarket(interaction.user.id, "client", deskTier))) {
        await interaction.reply({
          content: "Client access has not been granted for that desk.",
          ephemeral: true
        });
        return;
      }

      await interaction.showModal(buildNewJobModal(deskTier));
      return;
    }

    if (scope === "desk" && action === "my_jobs") {
      if (!deskTier || !(await this.access.canAccessMarket(interaction.user.id, "client", deskTier))) {
        await interaction.reply({
          content: "Client access has not been granted for that desk.",
          ephemeral: true
        });
        return;
      }

      const jobs = await this.jobs.listJobsByClient(interaction.user.id, deskTier);
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
      if (!deskTier || !(await this.access.canAccessMarket(interaction.user.id, "developer", deskTier))) {
        await interaction.reply({
          content: "Developer access has not been granted for that desk.",
          ephemeral: true
        });
        return;
      }

      await interaction.showModal(buildDeveloperProfileModal());
      return;
    }

    if (scope === "desk" && action === "my_applications") {
      if (!deskTier || !(await this.access.canAccessMarket(interaction.user.id, "developer", deskTier))) {
        await interaction.reply({
          content: "Developer access has not been granted for that desk.",
          ephemeral: true
        });
        return;
      }

      const applications = await this.jobs.listApplicationsByDeveloper(interaction.user.id, deskTier);
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

    if (scope === "job" && action === "publish" && entityId) {
      const job = await this.jobs.getJob(entityId);
      if (!job) {
        await interaction.reply({
          content: `Job ${entityId} was not found.`,
          ephemeral: true
        });
        return;
      }

      if (job.status === "in_progress" || job.status === "closed") {
        await interaction.reply({
          content: "This job cannot be published in its current state.",
          ephemeral: true
        });
        return;
      }

      if (
        !isStaff(member, this.appConfig) &&
        (interaction.user.id !== job.clientId ||
          !(await this.access.canAccessMarket(interaction.user.id, "client", job.marketTier)))
      ) {
        await interaction.reply({
          content: `You are not allowed to publish jobs into the ${job.marketTier} feed.`,
          ephemeral: true
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      const threadId = await this.jobs.publishJob(entityId);
      await interaction.editReply(`Published ${entityId} to ${job.marketTier}: <#${threadId}>`);
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

      await interaction.deferReply({ ephemeral: true });
      const applications = await this.jobs.shortlist(entityId);
      const room = await this.tickets.fetchTextChannel(job.privateChannelId);
      await room.send(this.jobs.formatShortlist(job, applications));
      await interaction.editReply(`Shortlist generated in ${room}.`);
      return;
    }

    if (scope === "job" && action === "suggest" && entityId) {
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
          content: "Only the client who owns the job or staff can request suggestions.",
          ephemeral: true
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      const suggestions = await this.jobs.suggestProfiles(entityId);
      const room = await this.tickets.fetchTextChannel(job.privateChannelId);
      for (const message of this.jobs.formatProfileSuggestionsMessages(job, suggestions)) {
        await room.send(message);
      }
      await interaction.editReply(`Suggestions generated in ${room}.`);
      return;
    }

    if (scope === "job" && action === "invite" && entityId && extra) {
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
          content: "Only the client who owns the job or staff can invite a candidate.",
          ephemeral: true
        });
        return;
      }

      if (job.status === "closed" || job.status === "in_progress") {
        await interaction.reply({
          content: "This job is not currently open for a new conversation.",
          ephemeral: true
        });
        return;
      }

      const profile = await this.profiles.getProfileByUserId(extra);
      if (!profile || profile.status !== "approved") {
        await interaction.reply({
          content: "That candidate is no longer available from published profiles.",
          ephemeral: true
        });
        return;
      }

      if (!(await this.access.canAccessMarket(profile.userId, "developer", job.marketTier))) {
        await interaction.reply({
          content: "That candidate no longer has access to this market.",
          ephemeral: true
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const invitePitch =
        "The client selected your published profile from the ranked developer suggestions for this job. Review the brief below and reply here if you want to continue.";

      let application: ApplicationRecord;
      try {
        application = await this.jobs.createApplication(job.id, profile.userId, {
          origin: "client_invite",
          pitch: invitePitch,
          matchingSkills: [],
          rate: "",
          availability: ""
        });
      } catch (error) {
        await interaction.message
          .edit({
            content: interaction.message.content,
            components: this.jobs.buildSuggestionInviteButtons(job.id, profile.userId, true)
          })
          .catch(() => undefined);
        await interaction.editReply(error instanceof Error ? error.message : "Candidate could not be invited.");
        return;
      }

      if (!interaction.guildId) {
        throw new Error("Suggestion invite interaction is missing guild context.");
      }

      const inviteGuild = interaction.guild ?? (await this.client.guilds.fetch(interaction.guildId));
      const ticket = await this.tickets.createPrivateTicket(
        inviteGuild,
        job.clientId,
        "dev_application",
        this.appConfig.categoryIds.devPrivate,
        {
          relatedJobId: job.id,
          relatedApplicationId: application.id,
          participantIds: [job.clientId, application.devUserId]
        }
      );
      const room = await this.tickets.fetchTextChannel(ticket.channelId);
      const connectedApplication: ApplicationRecord = {
        ...application,
        status: "connected",
        privateChannelId: room.id
      };
      const privateMessageId = await this.upsertChannelMessage(room, undefined, {
        content: this.jobs.renderApplicationConversationCard(job, connectedApplication, profile),
        components: this.jobs.buildApplicationConversationButtons(connectedApplication)
      });

      await this.jobs.connectApplication(application.id, room.id, privateMessageId);
      await this.syncApplicationMessages(application.id);
      await interaction.message
        .edit({
          content: interaction.message.content,
          components: this.jobs.buildSuggestionInviteButtons(job.id, profile.userId, true)
        })
        .catch(() => undefined);
      await interaction.editReply(`Invitation room created: ${room}`);
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

      await interaction.deferReply({ ephemeral: true });
      await this.jobs.closeJob(entityId);
      const room = await this.tickets.fetchTextChannel(job.privateChannelId);
      await room.send(`Job ${job.id} is now closed.`);
      await interaction.editReply(`Closed ${job.id}.`);
      return;
    }

    if (scope === "job" && action === "apply" && entityId) {
      const tier = await this.access.getTierForKind(interaction.user.id, "developer");
      if (!tier) {
        await interaction.reply({
          content: "Developer access has not been granted for your account yet.",
          ephemeral: true
        });
        return;
      }

      const job = await this.jobs.getJob(entityId);
      if (!job || job.status !== "published") {
        await interaction.reply({
          content: "This job is not currently accepting applications.",
          ephemeral: true
        });
        return;
      }

      if (!(await this.access.canAccessMarket(interaction.user.id, "developer", job.marketTier))) {
        await interaction.reply({
          content: `Your developer access does not cover the ${job.marketTier} market.`,
          ephemeral: true
        });
        return;
      }

      const profile = await this.profiles.getProfileByUserId(interaction.user.id);
      const profileThreadId = this.getPublishedProfileThreadId(profile);
      if (!profileThreadId) {
        await interaction.reply({
          content: "Create and publish your developer profile first before applying.",
          ephemeral: true
        });
        return;
      }

      await interaction.showModal(buildApplicationModal(entityId));
      return;
    }

    if (scope === "application" && action && entityId) {
      await this.handleApplicationButton(interaction, member, action, entityId);
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
      const marketTier = this.parseTier(entityId);
      if (!marketTier || !(await this.access.canAccessMarket(interaction.user.id, "client", marketTier))) {
        await interaction.reply({
          content: "Client access has not been granted for that desk.",
          ephemeral: true
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      const title = interaction.fields.getTextInputValue("job_title").trim();
      const summary = interaction.fields.getTextInputValue("job_summary").trim();
      const skills = (interaction.fields.getTextInputValue("job_skills") ?? "").trim();
      const budget = (interaction.fields.getTextInputValue("job_budget") ?? "").trim();
      const timeline = (interaction.fields.getTextInputValue("job_timeline") ?? "").trim();

      const ticket = await this.tickets.createPrivateTicket(
        guild,
        interaction.user.id,
        "client_job",
        this.appConfig.categoryIds.clientPrivate
      );

      const job = await this.jobs.createJob(interaction.user.id, ticket.channelId, marketTier, {
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
        components: this.jobs.buildJobManagementButtons(job)
      });

      await interaction.editReply(`Private job room created: ${room}`);
      return;
    }

    if (scope === "modal" && action === "dev_profile") {
      if (!(await this.access.hasKind(interaction.user.id, "developer"))) {
        await interaction.reply({
          content: "Developer access has not been granted for your account yet.",
          ephemeral: true
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      const headline = interaction.fields.getTextInputValue("profile_title").trim();
      const bio = interaction.fields.getTextInputValue("profile_summary").trim();
      const previousProjects = interaction.fields.getTextInputValue("profile_projects").trim();
      const skills = interaction.fields.getTextInputValue("profile_skills").trim();
      const portfolios = interaction.fields.getTextInputValue("profile_links").trim();
      const member = await guild.members.fetch(interaction.user.id);

      const profile = await this.profiles.submitProfile(member, {
        headline,
        bio,
        previousProjects,
        skills: skills
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        portfolioLinks: portfolios
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      });

      const threadId = this.getPublishedProfileThreadId(profile);
      await interaction.editReply(
        threadId
          ? `Profile synced to your network forum: <#${threadId}>`
          : `Profile ${profile.id} was saved, but no public profile thread was found.`
      );
      return;
    }

    if (scope === "modal" && action === "safety") {
      await interaction.deferReply({ ephemeral: true });
      const caseType = interaction.fields.getTextInputValue("case_type").trim();
      const details = interaction.fields.getTextInputValue("case_details").trim();

      const ticket = await this.tickets.createPrivateTicket(
        guild,
        interaction.user.id,
        "safety",
        this.appConfig.categoryIds.casePrivate
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

      await interaction.editReply(`Private safety case created: ${room}`);
      return;
    }

    if (scope === "modal" && action === "apply" && entityId) {
      if (!(await this.access.hasKind(interaction.user.id, "developer"))) {
        await interaction.reply({
          content: "Developer access has not been granted for your account yet.",
          ephemeral: true
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      const pitch = interaction.fields.getTextInputValue("app_pitch").trim();
      const matchingSkills = (interaction.fields.getTextInputValue("app_skills") ?? "").trim();
      const rate = (interaction.fields.getTextInputValue("app_rate") ?? "").trim();
      const availability = (interaction.fields.getTextInputValue("app_availability") ?? "").trim();
      const job = await this.jobs.getJob(entityId);
      if (!job || job.status !== "published") {
        await interaction.editReply("This job is not currently accepting applications.");
        return;
      }

      if (!(await this.access.canAccessMarket(interaction.user.id, "developer", job.marketTier))) {
        await interaction.editReply(`Your developer access does not cover the ${job.marketTier} market.`);
        return;
      }

      let application: ApplicationRecord;
      try {
        application = await this.jobs.createApplication(entityId, interaction.user.id, {
          pitch,
          matchingSkills: matchingSkills
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          rate,
          availability
        });
      } catch (error) {
        await interaction.editReply(error instanceof Error ? error.message : "Application could not be created.");
        return;
      }

      await this.syncApplicationMessages(application.id);

      await interaction.editReply("Application received. The client will review it in their private job room.");
      return;
    }

    if (scope === "modal" && (action === "feedback_completed" || action === "feedback_stopped") && entityId) {
      const application = await this.jobs.getApplication(entityId);
      if (!application) {
        await interaction.reply({
          content: `Application ${entityId} was not found.`,
          ephemeral: true
        });
        return;
      }

      const job = await this.jobs.getJob(application.jobId);
      if (!job) {
        await interaction.reply({
          content: `Job ${application.jobId} was not found.`,
          ephemeral: true
        });
        return;
      }

      if (interaction.user.id !== job.clientId) {
        await interaction.reply({
          content: "Only the client who owns the job can finish this contract and leave feedback.",
          ephemeral: true
        });
        return;
      }

      if (application.status !== "hired") {
        await interaction.reply({
          content: "This contract is no longer awaiting final feedback.",
          ephemeral: true
        });
        return;
      }

      const scoreRaw = interaction.fields.getTextInputValue("feedback_score").trim();
      const score = Number(scoreRaw);
      if (!Number.isInteger(score) || score < 1 || score > 5) {
        await interaction.reply({
          content: "Feedback score must be a whole number from 1 to 5.",
          ephemeral: true
        });
        return;
      }

      const feedbackMessage = interaction.fields.getTextInputValue("feedback_message").trim();

      const outcome = action === "feedback_completed" ? "completed" : "stopped";

      await interaction.deferReply({ ephemeral: true });
      await this.finalizeApplicationWithFeedback(guild, application, job, outcome, score, feedbackMessage);
      await interaction.editReply(
        `${outcome === "completed" ? "Completed" : "Stopped"} ${application.id} and saved feedback ${this.formatScoreStars(score)}.`
      );
      return;
    }

    await interaction.reply({
      content: "Unknown modal action.",
      ephemeral: true
    });
  }

  private async handleApplicationButton(
    interaction: ButtonInteraction,
    member: GuildMember,
    action: string,
    applicationId: string
  ): Promise<void> {
    const application = await this.jobs.getApplication(applicationId);
    if (!application) {
      await interaction.reply({
        content: `Application ${applicationId} was not found.`,
        ephemeral: true
      });
      return;
    }

    const job = await this.jobs.getJob(application.jobId);
    if (!job) {
      await interaction.reply({
        content: `Job ${application.jobId} was not found.`,
        ephemeral: true
      });
      return;
    }

    const canManageJob = isStaff(member, this.appConfig) || interaction.user.id === job.clientId;
    const canAccessConversation = canManageJob || interaction.user.id === application.devUserId;
    const canFinalizeHire = interaction.user.id === job.clientId;

    switch (action) {
      case "connect": {
        if (!canManageJob) {
          await interaction.reply({
            content: "Only the client who owns the job or staff can connect with an applicant.",
            ephemeral: true
          });
          return;
        }

        if (application.status !== "submitted") {
          await interaction.reply({
            content: "This application is no longer waiting for review.",
            ephemeral: true
          });
          return;
        }

        if (job.status === "closed" || job.status === "in_progress") {
          await interaction.reply({
            content: "This job is not currently open for a new conversation.",
            ephemeral: true
          });
          return;
        }

        await interaction.deferReply({ ephemeral: true });
        if (!interaction.guildId) {
          throw new Error("Application connect interaction is missing guild context.");
        }

        const guild = interaction.guild ?? (await this.client.guilds.fetch(interaction.guildId));
        const ticket = await this.tickets.createPrivateTicket(
          guild,
          job.clientId,
          "dev_application",
          this.appConfig.categoryIds.devPrivate,
          {
            relatedJobId: job.id,
            relatedApplicationId: application.id,
            participantIds: [job.clientId, application.devUserId]
          }
        );
        const room = await this.tickets.fetchTextChannel(ticket.channelId);
        const profile = await this.profiles.getProfileByUserId(application.devUserId);
        const connectedApplication: ApplicationRecord = {
          ...application,
          status: "connected",
          privateChannelId: room.id
        };
        const privateMessageId = await this.upsertChannelMessage(room, undefined, {
          content: this.jobs.renderApplicationConversationCard(job, connectedApplication, profile),
          components: this.jobs.buildApplicationConversationButtons(connectedApplication)
        });

        await this.jobs.connectApplication(application.id, room.id, privateMessageId);
        await this.syncApplicationMessages(application.id);
        await interaction.editReply(`Conversation room created: ${room}`);
        return;
      }

      case "reject": {
        if (!canManageJob) {
          await interaction.reply({
            content: "Only the client who owns the job or staff can reject an applicant.",
            ephemeral: true
          });
          return;
        }

        if (application.status !== "submitted") {
          await interaction.reply({
            content: "This application can no longer be rejected from review.",
            ephemeral: true
          });
          return;
        }

        await interaction.deferReply({ ephemeral: true });
        await this.jobs.rejectApplication(application.id);
        await this.syncApplicationMessages(application.id);
        await interaction.editReply(`Rejected ${application.id}.`);
        return;
      }

      case "hire": {
        if (!canManageJob) {
          await interaction.reply({
            content: "Only the client who owns the job or staff can hire from this room.",
            ephemeral: true
          });
          return;
        }

        if (application.status !== "connected") {
          await interaction.reply({
            content: "This application is not in an active conversation.",
            ephemeral: true
          });
          return;
        }

        if (job.status === "in_progress") {
          await interaction.reply({
            content: "This job already has an active hire.",
            ephemeral: true
          });
          return;
        }

        await interaction.deferReply({ ephemeral: true });
        const result = await this.jobs.hireApplication(application.id);
        await this.jobs.refreshPublishedJobPosts(result.job.id);
        await this.syncApplicationMessages(application.id);
        await interaction.editReply(`Marked ${application.id} as hired.`);
        return;
      }

      case "close": {
        if (!canAccessConversation) {
          await interaction.reply({
            content: "Only the client, the selected developer, or staff can close this conversation.",
            ephemeral: true
          });
          return;
        }

        if (application.status !== "connected") {
          await interaction.reply({
            content: "This conversation is already closed.",
            ephemeral: true
          });
          return;
        }

        await interaction.deferReply({ ephemeral: true });
        await this.jobs.closeApplicationConversation(application.id);
        if (application.privateChannelId) {
          await this.tickets.lockTextChannel(application.privateChannelId, [job.clientId, application.devUserId]);
        }
        await this.syncApplicationMessages(application.id);
        await interaction.editReply(`Closed conversation for ${application.id}.`);
        return;
      }

      case "complete": {
        if (!canFinalizeHire) {
          await interaction.reply({
            content: "Only the client who owns the job can complete this hire and leave feedback.",
            ephemeral: true
          });
          return;
        }

        if (application.status !== "hired") {
          await interaction.reply({
            content: "This hire is not currently in progress.",
            ephemeral: true
          });
          return;
        }

        await interaction.showModal(buildApplicationFeedbackModal(application.id, "completed"));
        return;
      }

      case "stop": {
        if (!canFinalizeHire) {
          await interaction.reply({
            content: "Only the client who owns the job can stop this hire and leave feedback.",
            ephemeral: true
          });
          return;
        }

        if (application.status !== "hired") {
          await interaction.reply({
            content: "This hire is not currently in progress.",
            ephemeral: true
          });
          return;
        }

        await interaction.showModal(buildApplicationFeedbackModal(application.id, "stopped"));
        return;
      }

      default:
        await interaction.reply({
          content: "Unknown application action.",
          ephemeral: true
        });
    }
  }

  private async syncApplicationMessages(applicationId: string): Promise<void> {
    const application = await this.jobs.getApplication(applicationId);
    if (!application) {
      return;
    }

    const job = await this.jobs.getJob(application.jobId);
    if (!job) {
      return;
    }

    const profile = await this.profiles.getProfileByUserId(application.devUserId);

    const clientRoom = await this.tickets.fetchTextChannel(job.privateChannelId);
    const reviewMessageId = await this.upsertChannelMessage(clientRoom, application.reviewMessageId, {
      content: this.jobs.renderApplicationReviewCard(job, application, profile),
      components: this.jobs.buildApplicationReviewButtons(application)
    });
    if (reviewMessageId !== application.reviewMessageId) {
      await this.jobs.setApplicationReviewMessageId(application.id, reviewMessageId);
    }

    if (!application.privateChannelId) {
      return;
    }

    const privateRoom = await this.tickets.fetchTextChannel(application.privateChannelId);
    const privateMessageId = await this.upsertChannelMessage(privateRoom, application.privateMessageId, {
      content: this.jobs.renderApplicationConversationCard(job, application, profile),
      components: this.jobs.buildApplicationConversationButtons(application)
    });
    if (privateMessageId !== application.privateMessageId) {
      await this.jobs.setApplicationPrivateMessageId(application.id, privateMessageId);
    }
  }

  private getPublishedProfileThreadId(profile: ProfileRecord | null): string | null {
    if (!profile) {
      return null;
    }

    if (profile.approvedTier && profile.publishedPostIds[profile.approvedTier]) {
      return profile.publishedPostIds[profile.approvedTier] ?? null;
    }

    return Object.values(profile.publishedPostIds).find(Boolean) ?? null;
  }

  private async upsertChannelMessage(
    channel: TextChannel,
    messageId: string | undefined,
    payload: {
      content: string;
      components: ActionRowBuilder<ButtonBuilder>[];
    }
  ): Promise<string> {
    if (messageId) {
      const existing = await channel.messages.fetch(messageId).catch(() => null);
      if (existing) {
        await existing.edit(payload);
        return existing.id;
      }
    }

    const created = await channel.send(payload);
    return created.id;
  }

  private async finalizeApplicationWithFeedback(
    guild: Guild,
    application: ApplicationRecord,
    job: JobRecord,
    outcome: "completed" | "stopped",
    score: number,
    feedbackMessage: string
  ): Promise<void> {
    const devMember = await guild.members.fetch(application.devUserId).catch(() => null);
    if (!devMember) {
      throw new Error(`Developer ${application.devUserId} could not be found for feedback.`);
    }

    if (outcome === "completed") {
      await this.jobs.completeApplication(application.id);
      await this.jobs.closeJob(job.id);
    } else {
      const result = await this.jobs.stopApplication(application.id);
      await this.jobs.refreshPublishedJobPosts(result.job.id);
    }

    await this.profiles.addFeedback(devMember, {
      jobId: job.id,
      applicationId: application.id,
      clientUserId: job.clientId,
      jobTitle: job.title,
      outcome,
      score,
      message: feedbackMessage
    });

    if (application.privateChannelId) {
      await this.tickets.lockTextChannel(application.privateChannelId, [job.clientId, application.devUserId]);
    }

    await this.syncApplicationMessages(application.id);
  }

  private formatScoreStars(score: number): string {
    const safeScore = Math.max(1, Math.min(5, Math.round(score)));

    return `${this.EMOJIS.full.repeat(safeScore)}${this.EMOJIS.empty.repeat(5 - safeScore)} ${safeScore}/5`;
  }

  private parseAccessKinds(value: string): AccountKind[] {
    switch (value) {
      case "client":
        return ["client"];
      case "developer":
        return ["developer"];
      case "both":
        return ["client", "developer"];
      default:
        return [];
    }
  }

  private parseTier(value: string | undefined): Tier | null {
    switch (value) {
      case "gold":
      case "silver":
      case "copper":
        return value;
      default:
        return null;
    }
  }

  private async deployPanels(): Promise<void> {
    const safetyDesk = await this.client.channels.fetch(this.appConfig.channelIds.safetyDesk);

    if (!safetyDesk?.isTextBased() || safetyDesk.isDMBased()) {
      throw new Error("Configured safety desk channel is invalid.");
    }

    const safetyDeskChannel = safetyDesk as TextChannel;
    const tiers: Tier[] = ["gold", "silver", "copper"];

    for (const tier of tiers) {
      const clientDesk = await this.client.channels.fetch(this.appConfig.channelIds.clientDesk[tier]);
      if (!clientDesk?.isTextBased() || clientDesk.isDMBased()) {
        throw new Error(`Configured ${tier} client desk channel is invalid.`);
      }

      const devDesk = await this.client.channels.fetch(this.appConfig.channelIds.devDesk[tier]);
      if (!devDesk?.isTextBased() || devDesk.isDMBased()) {
        throw new Error(`Configured ${tier} developer desk channel is invalid.`);
      }

      await (clientDesk as TextChannel).send({
        embeds: [this.jobs.buildClientDeskEmbed(tier)],
        components: this.jobs.buildClientDeskComponents(tier)
      });

      await (devDesk as TextChannel).send({
        embeds: [this.profiles.buildDeskEmbed(tier)],
        components: this.profiles.buildDeskComponents(tier)
      });
    }

    await safetyDeskChannel.send({
      embeds: [buildSafetyDeskEmbed()],
      components: buildSafetyDeskComponents()
    });
  }
}

function buildNewJobModal(tier: Tier): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`modal|new_job|${tier}`)
    .setTitle(`Create ${tier.charAt(0).toUpperCase()}${tier.slice(1)} Job`)
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
          .setLabel("Overview")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(4000)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("job_skills")
          .setLabel("Skills (comma separated)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(200)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("job_budget")
          .setLabel("Budget")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(100)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("job_timeline")
          .setLabel("Timeline")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
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
          .setCustomId("profile_title")
          .setLabel("Title")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("Senior React Engineer")
          .setMaxLength(100)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("profile_summary")
          .setLabel("Summary")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setPlaceholder("What you do well, what you focus on, and the type of work you are best suited for.")
          .setMaxLength(1500)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("profile_projects")
          .setLabel("Previous Projects")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setPlaceholder("Important products, clients, repos, or outcomes you have delivered.")
          .setMaxLength(1500)
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
          .setLabel("Links (GitHub, LinkedIn, Portfolio)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("https://github.com/..., https://linkedin.com/..., https://portfolio.com")
          .setMaxLength(500)
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
          .setRequired(false)
          .setMaxLength(200)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("app_rate")
          .setLabel("Rate / Pricing")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(100)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("app_availability")
          .setLabel("Availability")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(100)
      )
    );
}

function buildApplicationFeedbackModal(
  applicationId: string,
  outcome: "completed" | "stopped"
): ModalBuilder {
  const title = outcome === "completed" ? "Complete Contract" : "Stop Contract";
  const messageLabel = outcome === "completed" ? "Feedback (optional)" : "Why it stopped? (optional)";

  return new ModalBuilder()
    .setCustomId(`modal|feedback_${outcome}|${applicationId}`)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("feedback_score")
          .setLabel("Score (1 to 5)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("5")
          .setMinLength(1)
          .setMaxLength(1)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("feedback_message")
          .setLabel(messageLabel)
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(1000)
      )
    );
}
