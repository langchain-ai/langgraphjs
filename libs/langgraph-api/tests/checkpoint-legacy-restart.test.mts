import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serialize } from "../src/storage/persist.mjs";
import { InMemorySaver } from "../src/storage/checkpoint.mjs";

/**
 * A `.langgraphjs_api.checkpointer.json` file persisted by an older
 * `langgraph-api` holds MemorySaver write records without the `taskPath`
 * element (plain `[taskId, channel, serializedValue]` tuples). After
 * upgrading, the reloaded saver must keep reading them — the missing path
 * defaults to `""`, which sorts first, preserving the order they were
 * written in (see `writesSortKey` in `@langchain/langgraph-checkpoint`).
 */
describe("InMemorySaver restart with a legacy persistence file", () => {
  it("reads pre-taskPath write records in their original order", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lg-api-restart-"));
    try {
      const enc = new TextEncoder();
      const tid = "00000000-0000-0000-0000-000000000000";
      const last = "ffffffff-ffff-ffff-ffff-ffffffffffff";
      const checkpointId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
      // The exact on-disk shape `FileSystemPersistence` writes: superjson
      // serialization of `{ storage, writes }`, with the OLD 3-tuple records.
      const legacy = {
        storage: {
          t: {
            "": {
              [checkpointId]: [
                enc.encode(
                  JSON.stringify({
                    v: 4,
                    id: checkpointId,
                    ts: "2026-01-01T00:00:00.000Z",
                    channel_values: {},
                    channel_versions: {},
                    versions_seen: {},
                  })
                ),
                enc.encode(JSON.stringify({ source: "loop", step: 0, parents: {} })),
                undefined,
              ],
            },
          },
        },
        writes: {
          [JSON.stringify(["t", "", checkpointId])]: {
            [`${tid},0`]: [tid, "ch", enc.encode('"first"')],
            [`${last},0`]: [last, "ch", enc.encode('"second"')],
          },
        },
      };
      mkdirSync(join(cwd, ".langgraph_api"), { recursive: true });
      writeFileSync(
        join(cwd, ".langgraph_api", ".langgraphjs_api.checkpointer.json"),
        serialize(legacy)
      );

      const saver = new InMemorySaver();
      await saver.initialize(cwd);

      const tuple = await saver.getTuple({
        configurable: { thread_id: "t", checkpoint_ns: "", checkpoint_id: checkpointId },
      });
      expect(tuple?.pendingWrites?.map((w) => [w[0], w[2]])).toEqual([
        [tid, "first"],
        [last, "second"],
      ]);
      expect(tuple?.checkpoint.id).toBe(checkpointId);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
