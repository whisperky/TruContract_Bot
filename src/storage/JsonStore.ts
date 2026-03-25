import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { StoreSchema, TicketCounters, TicketRecord } from "../domain/models.js";

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
  tickets: [],
  counters: {
    profile: 0,
    job: 0,
    application: 0,
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

function normalizeStore(data: Partial<StoreSchema>): StoreSchema {
  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const applications = Array.isArray(data.applications) ? data.applications : [];
  const tickets = Array.isArray(data.tickets) ? data.tickets : [];

  return {
    profiles,
    jobs,
    applications,
    tickets,
    counters: {
      profile: data.counters?.profile ?? 0,
      job: data.counters?.job ?? 0,
      application: data.counters?.application ?? 0,
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
