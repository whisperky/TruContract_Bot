import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FeedbackRecord, ProfileRecord, StoreSchema, TicketCounters, TicketRecord } from "../domain/models.js";

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

function normalizeStore(data: Partial<StoreSchema>): StoreSchema {
  const profiles = normalizeProfiles(data.profiles);
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const applications = Array.isArray(data.applications) ? data.applications : [];
  const feedbacks = normalizeFeedbacks(data.feedbacks);
  const tickets = Array.isArray(data.tickets) ? data.tickets : [];

  return {
    profiles,
    jobs,
    applications,
    feedbacks,
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
