import { describe, expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { Annotation } from "../graph/index.js";
import { StateGraph } from "../graph/state.js";
import { START, END } from "../constants.js";
import { DeltaChannel } from "../channels/delta.js";
import { Send } from "../web.js";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";

/**
 * `DeltaChannel` replay must apply parallel writes in the order `invoke` did
 * (port of langgraph #8544's test_delta_channel_parallel_order.py). Live
 * execution orders a superstep's tasks by `(task_path, task_id, idx)` — see
 * `writesSortKey` — and every saver must replay in that same order, or an
 * order-sensitive (but batching-invariant) reducer rebuilds a different value
 * than the run produced.
 */

// Sorted, because live execution applies PULL tasks in node-name order.
const FAN_OUT_NAMES = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
] as const;
const SEND_ARGS = Array.from({ length: 12 }, (_, i) => `send-${String(i).padStart(2, "0")}`);

// Order-sensitive, batching-invariant: element order is user-visible.
const appendReducer = (state: string[], writes: string[][]): string[] => {
  const out = [...state];
  for (const w of writes) out.push(...w);
  return out;
};

const deltaState = () =>
  Annotation.Root({
    items: new DeltaChannel<string[], string[]>(appendReducer, {
      snapshotFrequency: 10_000,
    }),
  });

function buildFanOutGraph(checkpointer: BaseCheckpointSaver) {
  const State = deltaState();
  // One chained expression so each node is registered before its edges are
  // typed (dynamic addNode in a loop is not reflected in the builder's type).
  return new StateGraph(State)
    .addNode("a", () => ({ items: ["a"] }))
    .addEdge(START, "a")
    .addEdge("a", END)
    .addNode("b", () => ({ items: ["b"] }))
    .addEdge(START, "b")
    .addEdge("b", END)
    .addNode("c", () => ({ items: ["c"] }))
    .addEdge(START, "c")
    .addEdge("c", END)
    .addNode("d", () => ({ items: ["d"] }))
    .addEdge(START, "d")
    .addEdge("d", END)
    .addNode("e", () => ({ items: ["e"] }))
    .addEdge(START, "e")
    .addEdge("e", END)
    .addNode("f", () => ({ items: ["f"] }))
    .addEdge(START, "f")
    .addEdge("f", END)
    .addNode("g", () => ({ items: ["g"] }))
    .addEdge(START, "g")
    .addEdge("g", END)
    .addNode("h", () => ({ items: ["h"] }))
    .addEdge(START, "h")
    .addEdge("h", END)
    .compile({ checkpointer });
}

function buildSendFanOutGraph(checkpointer: BaseCheckpointSaver) {
  const State = deltaState();
  return new StateGraph(State)
    .addNode("worker", (arg: string) => ({ items: [arg] }))
    .addConditionalEdges(START, () => SEND_ARGS.map((n) => new Send("worker", n)))
    .addEdge("worker", END)
    .compile({ checkpointer });
}

const checkpointerFactories: Array<[string, () => BaseCheckpointSaver]> = [
  ["MemorySaver", () => new MemorySaver()],
  ["SqliteSaver", () => SqliteSaver.fromConnString(":memory:")],
];

describe.each(checkpointerFactories)(
  "DeltaChannel parallel write order (%s)",
  (_name, createCheckpointer) => {
    it("get_state matches the live Send order", async () => {
      const graph = buildSendFanOutGraph(createCheckpointer());
      const config = { configurable: { thread_id: "1" } };

      // `invoke` returns the output state values directly.
      const live = ((await graph.invoke({ items: [] }, config)) as {
        items: string[];
      }).items;
      const replayed = (await graph.getState(config)).values.items;

      expect(live).toEqual(SEND_ARGS);
      expect(replayed).toEqual(live);
    });

    it("get_state matches the live invoke order", async () => {
      const graph = buildFanOutGraph(createCheckpointer());
      const config = { configurable: { thread_id: "1" } };

      // `invoke` returns the output state values directly.
      const live = ((await graph.invoke({ items: [] }, config)) as {
        items: string[];
      }).items;
      const replayed = (await graph.getState(config)).values.items;

      expect(live).toEqual(FAN_OUT_NAMES);
      expect(replayed).toEqual(live);
    });

    it("a plain order-sensitive reducer channel agrees with the DeltaChannel", async () => {
      // Guards the live order itself: a plain (snapshot-per-checkpoint)
      // channel applies a superstep's writes in the same task-path order, so
      // both channel kinds must report the same sequence. Both agreeing on an
      // unintended order would require _applyWrites and every saver to be
      // wrong in the same way.
      const State = Annotation.Root({
        items: Annotation<string[]>({
          // A plain (non-delta) channel: the reducer takes (current, update).
          reducer: (current: string[], update: string[]) => [
            ...current,
            ...update,
          ],
          default: () => [],
        }),
      });
      const graph = new StateGraph(State)
      .addNode("a", () => ({ items: ["a"] }))
      .addEdge(START, "a")
      .addEdge("a", END)
      .addNode("b", () => ({ items: ["b"] }))
      .addEdge(START, "b")
      .addEdge("b", END)
      .addNode("c", () => ({ items: ["c"] }))
      .addEdge(START, "c")
      .addEdge("c", END)
      .addNode("d", () => ({ items: ["d"] }))
      .addEdge(START, "d")
      .addEdge("d", END)
      .addNode("e", () => ({ items: ["e"] }))
      .addEdge(START, "e")
      .addEdge("e", END)
      .addNode("f", () => ({ items: ["f"] }))
      .addEdge(START, "f")
      .addEdge("f", END)
      .addNode("g", () => ({ items: ["g"] }))
      .addEdge(START, "g")
      .addEdge("g", END)
      .addNode("h", () => ({ items: ["h"] }))
      .addEdge(START, "h")
      .addEdge("h", END)
        .compile({ checkpointer: createCheckpointer() });
      const config = { configurable: { thread_id: "1" } };

      // `invoke` returns the output state values directly.
      const live = ((await graph.invoke({ items: [] }, config)) as {
        items: string[];
      }).items;
      const replayed = (await graph.getState(config)).values.items;

      expect(live).toEqual(FAN_OUT_NAMES);
      expect(replayed).toEqual(live);
    });

    it("continuing a thread preserves the committed prefix", async () => {
      const graph = buildFanOutGraph(createCheckpointer());
      const config = { configurable: { thread_id: "1" } };

      const first = ((await graph.invoke({ items: [] }, config)) as {
        items: string[];
      }).items;
      const second = ((await graph.invoke({ items: [] }, config)) as {
        items: string[];
      }).items;

      expect(second).toEqual([...first, ...first]);
      expect((await graph.getState(config)).values.items).toEqual(second);
    });

    it("state history reports the live order at every step", async () => {
      const runs = 3;
      const graph = buildFanOutGraph(createCheckpointer());
      const config = { configurable: { thread_id: "1" } };
      for (let i = 0; i < runs; i += 1) {
        await graph.invoke({ items: [] }, config);
      }
      const live = Array.from({ length: runs }, () => FAN_OUT_NAMES).flat();

      const seen: string[][] = [];
      for await (const s of graph.getStateHistory(config)) {
        const items = (s.values as { items?: string[] }).items;
        if (items !== undefined) seen.push(items);
      }

      expect(Math.max(...seen.map((v) => v.length))).toBe(live.length);
      for (const values of seen) {
        expect(values).toEqual(live.slice(0, values.length));
      }
    });
  }
);
