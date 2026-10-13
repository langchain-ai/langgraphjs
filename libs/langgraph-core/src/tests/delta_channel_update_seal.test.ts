import { describe, expect, it } from "vitest";
import {
  BaseCheckpointSaver,
  MemorySaver,
  isDeltaSnapshot,
} from "@langchain/langgraph-checkpoint";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { Annotation } from "../graph/index.js";
import { StateGraph } from "../graph/state.js";
import { START } from "../constants.js";
import { DeltaChannel } from "../channels/delta.js";
import { interrupt } from "../interrupt.js";

/**
 * The #8548 first-superstep seal in `bulkUpdateState` (ported from Python):
 * a checkpoint's pending writes
 * belong to the child that consumed them, so a new branch snapshots every
 * delta channel they touch — its ancestor walk then never replays them, and
 * the relative order of the base's finished-task writes and the update's
 * writes stops mattering.
 */

const appendReducer = (current: string[], writes: string[][]): string[] => {
  const out = [...current];
  for (const w of writes) out.push(...w);
  return out;
};

const sealState = () =>
  Annotation.Root({
    log: new DeltaChannel<string[], string[]>(appendReducer),
    plain: Annotation<string[]>({
      reducer: (a, b) => [...a, ...b],
      default: () => [],
    }),
  });

const both = (marker: string) => ({ log: [marker], plain: [marker] });

const ask =
  (marker: string) => () => {
    interrupt("approve?");
    return both(marker);
  };

function buildGraph(checkpointer: BaseCheckpointSaver) {
  const State = sealState();
  return new StateGraph(State)
    .addNode("done", () => both("done"))
    .addNode("ask", ask("ask"))
    .addEdge(START, "done")
    .addEdge(START, "ask")
    .compile({ checkpointer });
}

const savers: Record<string, () => BaseCheckpointSaver> = {
  MemorySaver: () => new MemorySaver(),
  SqliteSaver: () => SqliteSaver.fromConnString(":memory:"),
};

describe("bulkUpdateState first-superstep seal", () => {
  for (const [name, makeSaver] of Object.entries(savers)) {
    it(`a finished sibling's writes no longer race the update (${name})`, async () => {
      const saver = makeSaver();
      const graph = buildGraph(saver);
      const config = { configurable: { thread_id: "seal-finished-sibling" } };
      await graph.invoke(both("in"), config);

      // `done` finished and wrote `log` (its write is pending on the head);
      // `ask` interrupted. The update's explicit task id is the smallest
      // possible uuid, so without the seal it would always replay before the
      // input and `done` writes (its path is "" while theirs are not — and
      // under the pre-change task-id order it sorts first as well).
      // The public bulkUpdateState type omits `taskId`, which the runtime
      // accepts; assign through a wider-typed variable so it is not an
      // excess property.
      const update: {
        values: Record<string, unknown>;
        asNode: string;
        taskId: string;
      } = {
        values: both("upd"),
        asNode: "ask",
        taskId: "00000000-0000-0000-0000-000000000000",
      };
      const nextConfig = await graph.bulkUpdateState(config, [
        { updates: [update] },
      ]);

      // The seal must actually reach storage: the update checkpoint carries a
      // snapshot of `log` (asserted through the saver, not just in memory).
      const tuple = await saver.getTuple(nextConfig);
      const values = tuple?.checkpoint.channel_values as Record<
        string,
        unknown
      >;
      expect(isDeltaSnapshot(values.log)).toBe(true);

      // Live folded [in, done] then applied the update: [in, done, upd].
      // Replay starts from the sealed snapshot, so it must agree — and the
      // plain channel (snapshot-per-checkpoint) cross-checks the order.
      const state = await graph.getState(config);
      const log = (state.values as { log: string[] }).log;
      const plain = (state.values as { plain: string[] }).plain;
      expect(log).toEqual(["in", "done", "upd"]);
      expect(log).toEqual(plain);
    });

    it(`an addressed update that writes the channel is sealed (${name})`, async () => {
      // Addressed updates skip folding the base's pending writes, so the seal
      // freezes the live value (Python #8548's behavior).
      const saver = makeSaver();
      const graph = buildGraph(saver);
      const config = { configurable: { thread_id: "seal-addressed-write" } };
      await graph.invoke(both("in"), config);
      const head = (await graph.getState(config)).config;

      const update: {
        values: Record<string, unknown>;
        asNode: string;
        taskId: string;
      } = {
        values: both("upd"),
        asNode: "ask",
        taskId: "00000000-0000-0000-0000-000000000000",
      };
      const nextConfig = await graph.bulkUpdateState(head, [
        { updates: [update] },
      ]);

      const tuple = await saver.getTuple(nextConfig);
      const values = tuple?.checkpoint.channel_values as Record<
        string,
        unknown
      >;
      expect(isDeltaSnapshot(values.log)).toBe(true);

      // Live applied only the update on top of the ancestors' value (the
      // base's pending writes are not folded for an addressed update):
      // [in, upd]. The sealed snapshot preserves exactly that.
      const state = await graph.getState(config);
      const log = (state.values as { log: string[] }).log;
      expect(log).toEqual(["in", "upd"]);
    });

    it(`an addressed update that skips the channel is sealed too (${name})`, async () => {
      const State = Annotation.Root({
        log: new DeltaChannel<string[], string[]>(appendReducer),
        other: Annotation<string[]>({
          reducer: (a, b) => [...a, ...b],
          default: () => [],
        }),
      });
      const saver = makeSaver();
      const graph = new StateGraph(State)
        .addNode("done", () => ({ log: ["done"] }))
        .addNode("ask", ask("ask"))
        .addEdge(START, "done")
        .addEdge(START, "ask")
        .compile({ checkpointer: saver });
      const config = { configurable: { thread_id: "seal-addressed-skip" } };
      await graph.invoke({ log: ["in"], other: [] }, config);
      const head = (await graph.getState(config)).config;

      const nextConfig = await graph.bulkUpdateState(head, [
        { updates: [{ values: { other: ["upd"] }, asNode: "ask" }] },
      ]);

      const tuple = await saver.getTuple(nextConfig);
      const values = tuple?.checkpoint.channel_values as Record<
        string,
        unknown
      >;
      expect(isDeltaSnapshot(values.log)).toBe(true);

      const state = await graph.getState(config);
      expect(
        (state.values as { log: string[] }).log,
        "an addressed update doesn't fold the base's pending writes"
      ).toEqual(["in"]);
    });
  }
});

describe("bulkUpdateState multi-update ordering", () => {
  const build = (checkpointer: BaseCheckpointSaver) => {
    const State = sealState();
    return new StateGraph(State)
      .addNode("n", () => both("x"))
      .addEdge(START, "n")
      .compile({ checkpointer });
  };

  it("establishes the base: one update replays exactly (no pending writes)", async () => {
    const saver = new MemorySaver();
    const graph = build(saver);
    const config = { configurable: { thread_id: "multi-update-single" } };
    await graph.invoke(both("in"), config);
    const head = (await graph.getState(config)).config;
    const headTuple = await saver.getTuple(head);
    expect(
      headTuple?.pendingWrites?.filter(([, ch]) => ch === "log") ?? []
    ).toEqual([]);

    await graph.bulkUpdateState(config, [
      { updates: [{ values: { log: ["only"] }, asNode: "n" }] },
    ]);

    const state = await graph.getState(config);
    expect((state.values as { log: string[] }).log).toEqual([
      "in",
      "x",
      "only",
    ]);
  });

  it(
    "multiple updates with explicit ids replay in the order given",
    async () => {
      const graph = build(new MemorySaver());
      const config = { configurable: { thread_id: "multi-update-order" } };
      await graph.invoke(both("in"), config);

      const first: {
        values: Record<string, unknown>;
        asNode: string;
        taskId: string;
      } = {
        values: { log: ["first"] },
        asNode: "n",
        taskId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      };
      const second: {
        values: Record<string, unknown>;
        asNode: string;
        taskId: string;
      } = {
        values: { log: ["second"] },
        asNode: "n",
        taskId: "00000000-0000-0000-0000-000000000000",
      };
      await graph.bulkUpdateState(config, [
        { updates: [first, second] },
      ]);

      const state = await graph.getState(config);
      const log = (state.values as { log: string[] }).log;
      expect(log).toEqual(["in", "x", "first", "second"]);
    }
  );
});
