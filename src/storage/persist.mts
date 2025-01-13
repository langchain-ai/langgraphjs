import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as superjson from "superjson";

// Add custom transformers for Uint8Array
superjson.registerCustom<Uint8Array, string>(
  {
    isApplicable: (v): v is Uint8Array => v instanceof Uint8Array,
    serialize: (v) => Buffer.from(v).toString("base64"),
    deserialize: (v) => new Uint8Array(Buffer.from(v, "base64")),
  },
  "Uint8Array"
);

export class FileSystemPersistence<Schema> {
  private filepath: string | null = null;
  private data: Schema | null = null;

  private defaultSchema: () => Schema;
  private name: string;

  private flushChain: Promise<void> = Promise.resolve<void>(undefined);

  constructor(name: `.${string}.json`, defaultSchema: () => Schema) {
    this.name = name;
    this.defaultSchema = defaultSchema;
  }

  async initialize(cwd: string) {
    this.filepath = path.resolve(cwd, ".langgraph_api", `${this.name}`);

    try {
      this.data = superjson.parse(await fs.readFile(this.filepath, "utf-8"));
    } catch {
      this.data = this.defaultSchema();
    }

    this.flushChain = this.flushChain.then(async () => {
      if (this.data == null || this.filepath == null) return;
      await fs.mkdir(path.dirname(this.filepath), { recursive: true });
    });

    return this;
  }

  protected schedulePersist() {
    this.flushChain = this.flushChain.then(async () => {
      if (this.data == null || this.filepath == null) return;
      await fs.writeFile(
        this.filepath,
        superjson.stringify(this.data),
        "utf-8"
      );
    });
  }

  async flush() {
    await this.flushChain;
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
    fn: ((data: Schema) => T) | T
  ) {
    if (this.filepath == null || this.data == null) {
      throw new Error(`${this.name} not initialized`);
    }

    try {
      const gen = typeof fn === "function" ? fn(this.data) : fn;
      yield* gen;
    } finally {
      this.schedulePersist();
    }
  }
}
