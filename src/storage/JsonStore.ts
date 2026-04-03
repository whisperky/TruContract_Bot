import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AccessRecord,
  ApplicationRecord,
  FeedbackRecord,
  JobRecord,
  ProfileRecord,
  StoreSchema,
  TicketCounters,
  TicketRecord,
  Tier
} from "../domain/models.js";

const DEFAULT_TICKET_COUNTERS: TicketCounters = {
  client_job: 0,
  client_support: 0,
  dev_profile: 0,
  dev_application: 0,
  safety: 0
};

const DEFAULT_STORE: StoreSchema = {
  profiles: [],
  jobs: [],
  applications: [],
  feedbacks: [],
  access: [],
  tickets: [],
  counters: {
    profile: 0,
    job: 0,
    application: 0,
    feedback: 0,
    ticket: 0,
    deal: 0,
    ticketByKind: { ...DEFAULT_TICKET_COUNTERS }
  }
};

function createTicketCounters(seed?: Partial<TicketCounters>): TicketCounters {
  return {
    ...DEFAULT_TICKET_COUNTERS,
    ...seed
  };
}

function parseSequenceFromId(id: string): number {
  const match = id.match(/-(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function deriveTicketCounters(
  tickets: TicketRecord[],
  storedCounters?: Partial<TicketCounters>
): TicketCounters {
  const counters = createTicketCounters(storedCounters);

  for (const ticket of tickets) {
    const sequence = parseSequenceFromId(ticket.id);
    if (sequence > counters[ticket.kind]) {
      counters[ticket.kind] = sequence;
    }
  }

  return counters;
}

function normalizeProfiles(data: Partial<StoreSchema>["profiles"]): ProfileRecord[] {
  if (!Array.isArray(data)) {
    return [];
  }

  return data.map((profile) => {
    const normalized: ProfileRecord = {
      id: profile?.id ?? "",
      userId: profile?.userId ?? "",
      headline: profile?.headline ?? "",
      bio: profile?.bio ?? "",
      previousProjects: profile?.previousProjects ?? "",
      skills: Array.isArray(profile?.skills) ? profile.skills : [],
      portfolioLinks: Array.isArray(profile?.portfolioLinks) ? profile.portfolioLinks : [],
      availability: profile?.availability ?? "",
      trustScore: profile?.trustScore ?? 50,
      moderatorStars: profile?.moderatorStars ?? 0,
      completedContracts: profile?.completedContracts ?? 0,
      stoppedContracts: profile?.stoppedContracts ?? 0,
      disputeCount: profile?.disputeCount ?? 0,
      feedbackCount: profile?.feedbackCount ?? 0,
      feedbackAverage: profile?.feedbackAverage ?? 0,
      status: profile?.status ?? "pending",
      visibilityTiers: Array.isArray(profile?.visibilityTiers)
        ? profile.visibilityTiers.filter(Boolean)
        : profile?.approvedTier
          ? [profile.approvedTier]
          : [],
      networkRegisteredAt: profile?.networkRegisteredAt ?? profile?.createdAt ?? "",
      publishedPostIds: profile?.publishedPostIds ?? {},
      createdAt: profile?.createdAt ?? "",
      updatedAt: profile?.updatedAt ?? profile?.createdAt ?? ""
    };

    if (profile?.approvedTier) {
      normalized.approvedTier = profile.approvedTier;
    }

    if (profile?.privateChannelId) {
      normalized.privateChannelId = profile.privateChannelId;
    }

    return normalized;
  });
}

function normalizeJobs(data: Partial<StoreSchema>["jobs"]): JobRecord[] {
  if (!Array.isArray(data)) {
    return [];
  }

  return data.map((job) => {
    const visibilityTiers = Array.isArray(job?.visibilityTiers) ? job.visibilityTiers.filter(isTier) : [];
    const marketTier = isTier(job?.marketTier) ? job.marketTier : highestTier(visibilityTiers) ?? "copper";

    return {
      id: job?.id ?? "",
      clientId: job?.clientId ?? "",
      marketTier,
      title: job?.title ?? "",
      summary: job?.summary ?? "",
      skills: Array.isArray(job?.skills) ? job.skills : [],
      budget: job?.budget ?? "",
      timeline: job?.timeline ?? "",
      visibilityTiers,
      status: job?.status ?? "draft",
      privateChannelId: job?.privateChannelId ?? "",
      publishedPostIds: job?.publishedPostIds ?? {},
      applicationIds: Array.isArray(job?.applicationIds) ? job.applicationIds : [],
      createdAt: job?.createdAt ?? "",
      updatedAt: job?.updatedAt ?? job?.createdAt ?? ""
    };
  });
}

function normalizeApplications(data: Partial<StoreSchema>["applications"]): ApplicationRecord[] {
  if (!Array.isArray(data)) {
    return [];
  }

  return data.map((application) => {
    const normalized: ApplicationRecord = {
      id: application?.id ?? "",
      jobId: application?.jobId ?? "",
      devUserId: application?.devUserId ?? "",
      origin: application?.origin === "client_invite" ? "client_invite" : "developer_apply",
      pitch: application?.pitch ?? "",
      matchingSkills: Array.isArray(application?.matchingSkills) ? application.matchingSkills : [],
      rate: application?.rate ?? "",
      availability: application?.availability ?? "",
      status: application?.status ?? "submitted",
      createdAt: application?.createdAt ?? "",
      updatedAt: application?.updatedAt ?? application?.createdAt ?? ""
    };

    if (typeof application?.reviewMessageId === "string" && application.reviewMessageId.length > 0) {
      normalized.reviewMessageId = application.reviewMessageId;
    }
    if (typeof application?.privateChannelId === "string" && application.privateChannelId.length > 0) {
      normalized.privateChannelId = application.privateChannelId;
    }
    if (typeof application?.privateMessageId === "string" && application.privateMessageId.length > 0) {
      normalized.privateMessageId = application.privateMessageId;
    }
    if (typeof application?.feedbackId === "string" && application.feedbackId.length > 0) {
      normalized.feedbackId = application.feedbackId;
    }
    if (typeof application?.score === "number") {
      normalized.score = application.score;
    }

    return normalized;
  });
}

function normalizeFeedbacks(data: Partial<StoreSchema>["feedbacks"]): FeedbackRecord[] {
  if (!Array.isArray(data)) {
    return [];
  }

  return data.map((feedback) => ({
    id: feedback?.id ?? "",
    jobId: feedback?.jobId ?? "",
    applicationId: feedback?.applicationId ?? "",
    clientUserId: feedback?.clientUserId ?? "",
    devUserId: feedback?.devUserId ?? "",
    jobTitle: feedback?.jobTitle ?? "",
    outcome: feedback?.outcome === "stopped" ? "stopped" : "completed",
    score: typeof feedback?.score === "number" ? feedback.score : 0,
    message: feedback?.message ?? "",
    createdAt: feedback?.createdAt ?? ""
  }));
}

function normalizeAccessRecords(
  data: Partial<StoreSchema>["access"],
  profiles: ProfileRecord[],
  jobs: StoreSchema["jobs"]
): AccessRecord[] {
  const accessByUserId = new Map<string, AccessRecord>();
  const explicitUserIds = new Set<string>();

  if (Array.isArray(data)) {
    for (const record of data) {
      if (!record?.userId || !isTier(record.tier)) {
        continue;
      }

      const normalized: AccessRecord = {
        userId: record.userId,
        kinds: Array.isArray(record.kinds)
          ? record.kinds.filter((kind): kind is AccessRecord["kinds"][number] => kind === "client" || kind === "developer")
          : [],
        tier: record.tier,
        createdAt: record.createdAt ?? "",
        updatedAt: record.updatedAt ?? record.createdAt ?? ""
      };

      if (typeof record.updatedBy === "string" && record.updatedBy.length > 0) {
        normalized.updatedBy = record.updatedBy;
      }

      accessByUserId.set(record.userId, normalized);
      explicitUserIds.add(record.userId);
    }
  }

  for (const profile of profiles) {
    const derivedTier = profile.approvedTier ?? profile.visibilityTiers[0] ?? "copper";
    const existing = accessByUserId.get(profile.userId);
    if (existing) {
      if (explicitUserIds.has(profile.userId)) {
        continue;
      }

      if (!existing.kinds.includes("developer")) {
        existing.kinds.push("developer");
      }
      existing.tier = pickHigherTier(existing.tier, derivedTier);
      existing.createdAt = existing.createdAt || profile.createdAt;
      existing.updatedAt = existing.updatedAt || profile.updatedAt || profile.createdAt;
      continue;
    }

    accessByUserId.set(profile.userId, {
      userId: profile.userId,
      kinds: ["developer"],
      tier: derivedTier,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt || profile.createdAt
    });
  }

  for (const job of jobs) {
    const derivedTier = highestTier(job.visibilityTiers) ?? "copper";
    const existing = accessByUserId.get(job.clientId);
    if (existing) {
      if (explicitUserIds.has(job.clientId)) {
        continue;
      }

      if (!existing.kinds.includes("client")) {
        existing.kinds.push("client");
      }
      existing.tier = pickHigherTier(existing.tier, derivedTier);
      existing.createdAt = existing.createdAt || job.createdAt;
      existing.updatedAt = existing.updatedAt || job.updatedAt || job.createdAt;
      continue;
    }

    accessByUserId.set(job.clientId, {
      userId: job.clientId,
      kinds: ["client"],
      tier: derivedTier,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt || job.createdAt
    });
  }

  return [...accessByUserId.values()]
    .map((record) => ({
      ...record,
      kinds: [...new Set(record.kinds)],
      createdAt: record.createdAt || record.updatedAt,
      updatedAt: record.updatedAt || record.createdAt
    }))
    .filter((record) => record.kinds.length > 0);
}

function highestTier(tiers: Tier[]): Tier | null {
  if (tiers.includes("gold")) {
    return "gold";
  }
  if (tiers.includes("silver")) {
    return "silver";
  }
  if (tiers.includes("copper")) {
    return "copper";
  }

  return null;
}

function isTier(value: string): value is Tier {
  return value === "gold" || value === "silver" || value === "copper";
}

function pickHigherTier(left: Tier, right: Tier): Tier {
  const order: Record<Tier, number> = {
    gold: 3,
    silver: 2,
    copper: 1
  };

  return order[left] >= order[right] ? left : right;
}

function normalizeStore(data: Partial<StoreSchema>): StoreSchema {
  const profiles = normalizeProfiles(data.profiles);
  const jobs = normalizeJobs(data.jobs);
  const applications = normalizeApplications(data.applications);
  const feedbacks = normalizeFeedbacks(data.feedbacks);
  const access = normalizeAccessRecords(data.access, profiles, jobs);
  const tickets = Array.isArray(data.tickets) ? data.tickets : [];

  return {
    profiles,
    jobs,
    applications,
    feedbacks,
    access,
    tickets,
    counters: {
      profile: data.counters?.profile ?? 0,
      job: data.counters?.job ?? 0,
      application: data.counters?.application ?? 0,
      feedback: data.counters?.feedback ?? 0,
      ticket: data.counters?.ticket ?? 0,
      deal: data.counters?.deal ?? 0,
      ticketByKind: deriveTicketCounters(tickets, data.counters?.ticketByKind)
    }
  };
}

export class JsonStore {
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  async get(): Promise<StoreSchema> {
    const data = await this.read();
    return structuredClone(data);
  }

  async mutate<T>(mutator: (draft: StoreSchema) => T | Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const draft = await this.read();
      const result = await mutator(draft);
      await this.write(draft);
      return result;
    });

    this.queue = task.then(
      () => undefined,
      () => undefined
    );

    return task;
  }

  private async ensureParentDir(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
  }

  private async read(): Promise<StoreSchema> {
    await this.ensureParentDir();

    try {
      const raw = await readFile(this.filePath, "utf8");
      return normalizeStore(JSON.parse(raw) as Partial<StoreSchema>);
    } catch {
      await this.write(structuredClone(DEFAULT_STORE));
      return structuredClone(DEFAULT_STORE);
    }
  }

  private async write(data: StoreSchema): Promise<void> {
    await this.ensureParentDir();
    await writeFile(this.filePath, JSON.stringify(data, null, 2), "utf8");
  }
}
