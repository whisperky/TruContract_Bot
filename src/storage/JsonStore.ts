import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { StoreSchema } from "../domain/models.js";

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
    deal: 0
  }
};

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
      return JSON.parse(raw) as StoreSchema;
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
