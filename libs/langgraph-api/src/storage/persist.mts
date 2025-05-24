import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as superjson from "superjson";
import * as importMap from "./importMap.mjs";
import { load } from "@langchain/core/load";

// Add custom transformers for Uint8Array
superjson.registerCustom<Uint8Array, string>(
  {
    isApplicable: (v): v is Uint8Array => v instanceof Uint8Array,
    serialize: (v) => Buffer.from(v).toString("base64"),
    deserialize: (v) => new Uint8Array(Buffer.from(v, "base64")),
  },
  "Uint8Array",
);

export function serialize(data: unknown) {
  return superjson.stringify(data);
}

export async function deserialize<T>(input: string) {
  const result = await load(input, { importMap });
  return superjson.deserialize<T>(result as superjson.SuperJSONResult);
}

export class FileSystemPersistence<Schema> {
  private filepath: string | null = null;
  private data: Schema | null = null;

  private defaultSchema: () => Schema;
  private name: string;

  private flushTimeout: NodeJS.Timeout | undefined = undefined;

  constructor(name: `.${string}.json`, defaultSchema: () => Schema) {
    this.name = name;
    this.defaultSchema = defaultSchema;
  }

  async initialize(cwd: string) {
    this.filepath = path.resolve(cwd, ".langgraph_api", `${this.name}`);

    try {
      this.data = await deserialize(await fs.readFile(this.filepath, "utf-8"));
    } catch {
      this.data = this.defaultSchema();
    }

    await fs
      .mkdir(path.dirname(this.filepath), { recursive: true })
      .catch(() => void 0);

    return this;
  }

  protected async persist() {
    if (this.data == null || this.filepath == null) return;
    clearTimeout(this.flushTimeout);
    await fs.writeFile(this.filepath, serialize(this.data), "utf-8");
  }

  protected schedulePersist() {
    clearTimeout(this.flushTimeout);
    this.flushTimeout = setTimeout(() => this.persist(), 3000);
  }

  async flush() {
    await this.persist();
  }

  async with<T>(fn: (data: Schema) => T) {
    if (this.filepath == null || this.data == null) {
      throw new Error(`${this.name} not initialized`);
    }

    try {
      return await fn(this.data);
    } finally {
      this.schedulePersist();
    }
  }

  async *withGenerator<T extends AsyncGenerator<any>>(
    fn: ((data: Schema, options: { schedulePersist: () => void }) => T) | T,
  ) {
    if (this.filepath == null || this.data == null) {
      throw new Error(`${this.name} not initialized`);
    }

    let shouldPersist = false;
    let schedulePersist = () => void (shouldPersist = true);

    try {
      const gen =
        typeof fn === "function" ? fn(this.data, { schedulePersist }) : fn;
      yield* gen;
    } finally {
      if (shouldPersist) this.schedulePersist();
    }
  }
}
