import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileSystemPersistence,
  deserialize,
  serialize,
} from "../src/storage/persist.mjs";
import { FileSystemOps } from "../src/storage/ops.mjs";
import type { Store } from "../src/storage/types.mjs";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { gatherIterator } from "./utils.mjs";

describe("persist", () => {
  it("basic", async () => {
    const data = { a: 1, b: "test" };
    const serialized = serialize(data);
    const deserialized = await deserialize(serialized);
    expect(deserialized).toEqual(data);
  });

  it("langchain messages", async () => {
    const data = [new HumanMessage("hello"), new AIMessage("world")];
    const serialized = serialize(data);
    const deserialized = await deserialize<typeof data>(serialized);

    expect(deserialized).toHaveLength(2);
    expect(deserialized[0]).toHaveProperty("lc_id");
    expect(deserialized[1]).toHaveProperty("lc_id");
    expect(deserialized).toMatchObject(data);
  });

  it("uint8array", async () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const serialized = serialize(data);
    const deserialized = await deserialize<typeof data>(serialized);

    expect(deserialized).toBeInstanceOf(Uint8Array);
    expect(deserialized).toEqual(data);
  });

  it("retries a run the previous process left running", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lg-api-persist-"));
    const conn = new FileSystemPersistence<Store>(
      ".langgraphjs_ops.json",
      () => ({
        runs: {},
        threads: {},
        assistants: {},
        assistant_versions: [],
        retry_counter: {},
      })
    );

    try {
      const startedAt = new Date(Date.now() - 1_000);
      mkdirSync(join(cwd, ".langgraph_api"));
      writeFileSync(
        join(cwd, ".langgraph_api", ".langgraphjs_ops.json"),
        serialize({
          runs: {
            run: {
              run_id: "run",
              thread_id: "thread",
              assistant_id: "agent",
              status: "running",
              metadata: {},
              kwargs: {},
              multitask_strategy: "reject",
              created_at: startedAt,
              updated_at: startedAt,
            },
          },
          threads: {
            thread: {
              thread_id: "thread",
              status: "busy",
              created_at: startedAt,
              updated_at: startedAt,
            },
          },
          assistants: {},
          assistant_versions: [],
          retry_counter: { run: 1 },
        } satisfies Store)
      );
      const ops = new FileSystemOps(await conn.initialize(cwd));

      const claims = ops.runs.next();
      expect((await claims.next()).value).toMatchObject({
        run: { run_id: "run" },
        attempt: 2,
      });

      expect(await gatherIterator(ops.runs.next())).toEqual([]);
      expect((await ops.runs.get("run", "thread", undefined))?.status).toBe(
        "running"
      );

      await claims.return(undefined);
    } finally {
      await conn.flush();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
