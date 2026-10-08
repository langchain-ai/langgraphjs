import { describe, expect, it } from "vitest";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  type Checkpoint,
  type CheckpointTuple,
  emptyCheckpoint,
} from "../base.js";
import type { CheckpointMetadata } from "../types.js";
import { MemorySaver } from "../memory.js";

/**
 * Records written before the `taskPath` element existed — e.g. a
 * `.langgraphjs_api.checkpointer.json` file persisted by an older
 * `langgraph-api` and reloaded after upgrade — must keep reading correctly:
 * the missing path defaults to `""`, which sorts first, by `(taskId, idx)`.
 */
describe("MemorySaver legacy 3-tuple write records", () => {
  it("reads old-format records in task-id order", async () => {
    const saver = new MemorySaver();
    const cfg: RunnableConfig = {
      configurable: { thread_id: "t", checkpoint_ns: "", checkpoint_id: "c" },
    };
    const checkpoint: Checkpoint = { ...emptyCheckpoint(), id: "c" };
    const metadata: CheckpointMetadata = { source: "loop", step: 0, parents: {} };
    await saver.put(cfg, checkpoint, metadata);

    // Old on-disk shape: `[taskId, channel, serializedValue]` keyed by
    // `${taskId},${idx}`, the same shape MemorySaver keys its writes by.
    const key = JSON.stringify(["t", "", "c"]);
    const enc = new TextEncoder();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (saver.writes as any)[key] = {
      "ffffffff-ffff-ffff-ffff-ffffffffffff,0": [
        "ffffffff-ffff-ffff-ffff-ffffffffffff",
        "ch",
        enc.encode('"written first"'),
      ],
      "00000000-0000-0000-0000-000000000000,0": [
        "00000000-0000-0000-0000-000000000000",
        "ch",
        enc.encode('"written second"'),
      ],
    };

    const tuple = (await saver.getTuple(cfg)) as CheckpointTuple;
    expect(tuple.pendingWrites?.map((w) => [w[0], w[2]])).toEqual([
      ["00000000-0000-0000-0000-000000000000", "written second"],
      ["ffffffff-ffff-ffff-ffff-ffffffffffff", "written first"],
    ]);
  });

  it("orders a mix of legacy and new records by writesSortKey", async () => {
    const saver = new MemorySaver();
    const cfg: RunnableConfig = {
      configurable: { thread_id: "t2", checkpoint_ns: "", checkpoint_id: "c2" },
    };
    const checkpoint: Checkpoint = { ...emptyCheckpoint(), id: "c2" };
    const metadata: CheckpointMetadata = { source: "loop", step: 0, parents: {} };
    const config = await saver.put(cfg, checkpoint, metadata);
    // New-format write: path sorts before "" only if "" were absent — here the
    // legacy record has "" (first), the new record a real path (after).
    await saver.putWrites(
      config,
      [["ch", "new"]],
      "88888888-8888-8888-8888-888888888888",
      "~pull, later"
    );
    const key = JSON.stringify(["t2", "", "c2"]);
    const enc = new TextEncoder();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (saver.writes as any)[key][
      "ffffffff-ffff-ffff-ffff-ffffffffffff,0"
    ] = [
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "ch",
      enc.encode('"legacy"'),
    ];

    const tuple = (await saver.getTuple(cfg)) as CheckpointTuple;
    // "" (legacy) sorts before "~pull, later" (new), regardless of ids.
    expect(tuple.pendingWrites?.map((w) => w[2])).toEqual(["legacy", "new"]);
  });
});
