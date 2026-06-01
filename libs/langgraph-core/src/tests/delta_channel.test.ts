import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  RemoveMessage,
} from "@langchain/core/messages";
import {
  MemorySaver,
  DeltaSnapshot,
  isDeltaSnapshot,
  type Checkpoint,
  type CheckpointMetadata,
} from "@langchain/langgraph-checkpoint";
import { DeltaChannel } from "../channels/delta.js";
import {
  channelsFromCheckpoint,
  createCheckpoint,
  deltaChannelsToSnapshot,
} from "../channels/base.js";
import {
  messagesDeltaReducer,
  type Messages,
} from "../graph/messages_reducer.js";
import { Annotation } from "../graph/index.js";
import { StateGraph } from "../graph/state.js";
import { START, END } from "../constants.js";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";

// A simple associative batch reducer over arrays.
const listReducer = (state: number[], writes: number[][]): number[] => {
  const out = [...state];
  for (const w of writes) out.push(...w);
  return out;
};

describe("DeltaChannel (unit)", () => {
  it("rejects a non-positive snapshotFrequency", () => {
    expect(() => new DeltaChannel(listReducer, { snapshotFrequency: 0 })).toThrow();
    expect(
      () => new DeltaChannel(listReducer, { snapshotFrequency: -1 })
    ).toThrow();
    expect(() => new DeltaChannel(listReducer, { snapshotFrequency: 1.5 })).toThrow();
  });

  it("update applies the batch reducer", () => {
    const ch = new DeltaChannel<number[], number[]>(listReducer);
    expect(ch.isAvailable()).toBe(false);
    ch.update([[1, 2], [3]]);
    expect(ch.get()).toEqual([1, 2, 3]);
    ch.update([[4]]);
    expect(ch.get()).toEqual([1, 2, 3, 4]);
  });

  it("update returns false for empty values", () => {
    const ch = new DeltaChannel<number[], number[]>(listReducer);
    expect(ch.update([])).toBe(false);
  });

  it("checkpoint() always returns undefined (sentinel)", () => {
    const ch = new DeltaChannel<number[], number[]>(listReducer);
    ch.update([[1]]);
    expect(ch.checkpoint()).toBeUndefined();
  });

  it("fromCheckpoint restores from MISSING, DeltaSnapshot, and plain value", () => {
    const spec = new DeltaChannel<number[], number[]>(listReducer);

    const fromMissing = spec.fromCheckpoint(undefined);
    expect(fromMissing.get()).toEqual([]);

    const fromSnapshot = spec.fromCheckpoint(new DeltaSnapshot([1, 2, 3]));
    expect(fromSnapshot.get()).toEqual([1, 2, 3]);

    const fromPlain = spec.fromCheckpoint([9, 8]);
    expect(fromPlain.get()).toEqual([9, 8]);
  });

  it("replayWrites folds ancestor writes oldest-to-newest", () => {
    const ch = new DeltaChannel<number[], number[]>(listReducer).fromCheckpoint(
      undefined
    );
    ch.replayWrites([
      ["t1", "messages", [1]],
      ["t2", "messages", [2, 3]],
      ["t3", "messages", [4]],
    ]);
    expect(ch.get()).toEqual([1, 2, 3, 4]);
  });

  it("replayWrites honors a trailing Overwrite as a reset point", () => {
    const ch = new DeltaChannel<number[], number[]>(listReducer).fromCheckpoint(
      [100]
    );
    ch.replayWrites([
      ["t1", "messages", [1]],
      ["t2", "messages", { __overwrite__: [50] }],
      ["t3", "messages", [4]],
    ]);
    expect(ch.get()).toEqual([50, 4]);
  });

  it("update rejects multiple Overwrite values in one step", () => {
    const ch = new DeltaChannel<number[], number[]>(listReducer);
    expect(() =>
      ch.update([{ __overwrite__: [1] }, { __overwrite__: [2] }])
    ).toThrow();
  });

  it("reload reproduces live state when a plain write precedes an Overwrite in one step", () => {
    // Live: a single super-step receives [1] then Overwrite([50]).
    const live = new DeltaChannel<number[], number[]>(listReducer);
    live.update([[1], { __overwrite__: [50] }]);

    // Reload: the same two writes are replayed from the checkpoint.
    const replayed = new DeltaChannel<number[], number[]>(
      listReducer
    ).fromCheckpoint(undefined);
    replayed.replayWrites([
      ["t1", "messages", [1]],
      ["t2", "messages", { __overwrite__: [50] }],
    ]);

    // Overwrite is a hard reset: the pre-overwrite [1] is dropped on both paths.
    expect(live.get()).toEqual([50]);
    // Invariant: reconstructed state must equal live state.
    expect(replayed.get()).toEqual(live.get());
  });

  it("equals compares reducer and snapshotFrequency", () => {
    const a = new DeltaChannel(listReducer);
    const b = new DeltaChannel(listReducer);
    const c = new DeltaChannel(listReducer, { snapshotFrequency: 5 });
    const d = new DeltaChannel((s: number[], w: number[][]) =>
      listReducer(s, w)
    );
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(a.equals(d)).toBe(false);
  });
});

describe("messagesDeltaReducer", () => {
  it("appends, dedups by id and is batching-invariant", () => {
    const m1 = new HumanMessage({ id: "1", content: "a" });
    const m2 = new AIMessage({ id: "2", content: "b" });
    const m2b = new AIMessage({ id: "2", content: "b-updated" });

    const once = messagesDeltaReducer([], [[m1], [m2], [m2b]]);
    const split = messagesDeltaReducer(
      messagesDeltaReducer([], [[m1], [m2]]),
      [[m2b]]
    );
    expect(once.map((m) => m.content)).toEqual(["a", "b-updated"]);
    // associativity: same result whether applied in one batch or two
    expect(split.map((m) => m.content)).toEqual(once.map((m) => m.content));
    expect(split.map((m) => m.id)).toEqual(once.map((m) => m.id));
  });

  it("tombstones via RemoveMessage", () => {
    const m1 = new HumanMessage({ id: "1", content: "a" });
    const m2 = new AIMessage({ id: "2", content: "b" });
    const out = messagesDeltaReducer(
      [m1, m2],
      [[new RemoveMessage({ id: "1" })]]
    );
    expect(out.map((m) => m.id)).toEqual(["2"]);
  });

  it("coerces raw string writes to typed messages (#7680)", () => {
    // HTTP-driven graphs may emit raw strings instead of BaseMessage objects.
    const out = messagesDeltaReducer([] as BaseMessage[], [
      "hello" as unknown as Messages,
      "there" as unknown as Messages,
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((m) => BaseMessage.isInstance(m))).toBe(true);
    expect(out.map((m) => m.content)).toEqual(["hello", "there"]);
  });

  it("coerces a deserialized state of raw messages on the slow path", () => {
    // Simulates a state restored from a blob where the first element is a
    // plain object rather than a BaseMessage instance.
    const rawState = [
      { type: "human", content: "old", id: "x" },
    ] as unknown as BaseMessage[];
    const out = messagesDeltaReducer(rawState, [
      [new AIMessage({ id: "y", content: "new" })],
    ]);
    expect(out.map((m) => m.content)).toEqual(["old", "new"]);
    expect(out.every((m) => BaseMessage.isInstance(m))).toBe(true);
  });

  it("flattens array writes and treats non-arrays as single messages", () => {
    const a = new AIMessage({ id: "a", content: "x" });
    const b = new AIMessage({ id: "b", content: "y" });
    const out = messagesDeltaReducer([], [[a, b], b]);
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("createCheckpoint / deltaChannelsToSnapshot", () => {
  it("omits delta channels from channel_values unless snapshotting", () => {
    const checkpoint = emptyCheckpoint();
    checkpoint.channel_versions = { messages: 1, other: 1 };
    const channels = {
      messages: new DeltaChannel<number[], number[]>(listReducer),
      other: new DeltaChannel<number[], number[]>(listReducer),
    };
    channels.messages.update([[1, 2]]);
    channels.other.update([[9]]);

    const cp = createCheckpoint(checkpoint, channels, 0, {
      channelsToSnapshot: new Set(["messages"]),
    });
    // snapshotted channel stored as a DeltaSnapshot, the other omitted
    expect(isDeltaSnapshot(cp.channel_values.messages)).toBe(true);
    expect((cp.channel_values.messages as DeltaSnapshot).value).toEqual([1, 2]);
    expect("other" in cp.channel_values).toBe(false);
  });

  it("deltaChannelsToSnapshot fires on update OR superstep bound", () => {
    const channels = {
      a: new DeltaChannel<number[], number[]>(listReducer, {
        snapshotFrequency: 3,
      }),
      b: new DeltaChannel<number[], number[]>(listReducer, {
        snapshotFrequency: 1000,
      }),
    };
    channels.a.update([[1]]);
    channels.b.update([[1]]);
    // a reached its update frequency (3); b reached the superstep bound
    const out = deltaChannelsToSnapshot(channels, {
      a: [3, 3],
      b: [0, 5000],
    });
    expect(out.has("a")).toBe(true);
    expect(out.has("b")).toBe(true);
    // neither bound reached
    expect(deltaChannelsToSnapshot(channels, { a: [1, 1], b: [0, 1] }).size).toBe(
      0
    );
  });
});

describe("MemorySaver.getDeltaChannelHistory", () => {
  it("walks ancestors collecting writes oldest→newest with a snapshot seed", async () => {
    const saver = new MemorySaver();
    const threadId = "t-history";
    const baseConfig = {
      configurable: { thread_id: threadId, checkpoint_ns: "" },
    };

    // cp0: snapshot seed [0]
    const cp0: Checkpoint = {
      ...emptyCheckpoint(),
      id: "00000000-0000-0000-0000-000000000000",
      channel_values: { messages: new DeltaSnapshot([0]) },
      channel_versions: { messages: 1 },
    };
    const meta: CheckpointMetadata = { source: "loop", step: 0, parents: {} };
    const c0 = await saver.put(baseConfig, cp0, meta);
    await saver.putWrites(c0, [["messages", [1]]], "task0");

    // cp1: delta (no value), writes [2]
    const cp1: Checkpoint = {
      ...emptyCheckpoint(),
      id: "00000000-0000-0000-0000-000000000001",
      channel_values: {},
      channel_versions: { messages: 2 },
    };
    const c1 = await saver.put(c0, cp1, meta);
    await saver.putWrites(c1, [["messages", [2]]], "task1");

    // cp2: delta (no value), target
    const cp2: Checkpoint = {
      ...emptyCheckpoint(),
      id: "00000000-0000-0000-0000-000000000002",
      channel_values: {},
      channel_versions: { messages: 3 },
    };
    const c2 = await saver.put(c1, cp2, meta);

    const hist = await saver.getDeltaChannelHistory({
      config: c2,
      channels: ["messages"],
    });
    expect(isDeltaSnapshot(hist.messages.seed)).toBe(true);
    expect((hist.messages.seed as DeltaSnapshot).value).toEqual([0]);
    // writes collected from cp0 (seed ancestor) and cp1, oldest→newest
    expect(hist.messages.writes.map((w) => w[2])).toEqual([[1], [2]]);
  });

  it("base default implementation agrees with the override for snapshots", async () => {
    // The base implementation walks getTuple()+parentConfig.
    const saver = new MemorySaver();
    const threadId = "t-base";
    const cfg = { configurable: { thread_id: threadId, checkpoint_ns: "" } };
    const meta: CheckpointMetadata = { source: "loop", step: 0, parents: {} };

    const cp0: Checkpoint = {
      ...emptyCheckpoint(),
      id: "00000000-0000-0000-0000-0000000000a0",
      channel_values: { messages: new DeltaSnapshot([0]) },
      channel_versions: { messages: 1 },
    };
    const c0 = await saver.put(cfg, cp0, meta);
    await saver.putWrites(c0, [["messages", [1]]], "task0");
    const cp1: Checkpoint = {
      ...emptyCheckpoint(),
      id: "00000000-0000-0000-0000-0000000000a1",
      channel_values: {},
      channel_versions: { messages: 2 },
    };
    const c1 = await saver.put(c0, cp1, meta);

    const override = await saver.getDeltaChannelHistory({
      config: c1,
      channels: ["messages"],
    });
    // Call the base prototype implementation directly.
    const base = await Object.getPrototypeOf(
      Object.getPrototypeOf(saver)
    ).getDeltaChannelHistory.call(saver, { config: c1, channels: ["messages"] });
    expect((override.messages.seed as DeltaSnapshot).value).toEqual(
      (base.messages.seed as DeltaSnapshot).value
    );
    expect(override.messages.writes.map((w) => w[2])).toEqual(
      base.messages.writes.map((w: [string, string, unknown]) => w[2])
    );
  });
});

describe("DeltaChannel end-to-end via StateGraph", () => {
  const buildGraph = (snapshotFrequency: number) => {
    const State = Annotation.Root({
      messages: new DeltaChannel<BaseMessage[], Messages>(
        messagesDeltaReducer,
        { snapshotFrequency }
      ),
    });
    let turn = 0;
    return new StateGraph(State)
      .addNode("chat", () => {
        turn += 1;
        return { messages: [new AIMessage({ content: `reply ${turn}` })] };
      })
      .addEdge(START, "chat")
      .addEdge("chat", END)
      .compile({ checkpointer: new MemorySaver() });
  };

  const durabilities = ["async", "sync", "exit"] as const;
  for (const durability of durabilities) {
    it(`reconstructs accumulated messages across turns (durability=${durability}, no snapshots)`, async () => {
      const graph = buildGraph(1000);
      const config = {
        configurable: { thread_id: "thread-1" },
        durability,
      };

      for (let i = 0; i < 4; i += 1) {
        await graph.invoke({ messages: [new HumanMessage(`hi ${i}`)] }, config);
      }

      const state = await graph.getState(config);
      const contents = (state.values as { messages: BaseMessage[] }).messages.map(
        (m) => m.content
      );
      expect(contents).toEqual([
        "hi 0",
        "reply 1",
        "hi 1",
        "reply 2",
        "hi 2",
        "reply 3",
        "hi 3",
        "reply 4",
      ]);
    });
  }

  it("does not store the full value in non-snapshot checkpoint blobs", async () => {
    const graph = buildGraph(1000);
    const saver = (graph as unknown as { checkpointer: MemorySaver })
      .checkpointer;
    const config = { configurable: { thread_id: "thread-blobs" } };
    for (let i = 0; i < 3; i += 1) {
      await graph.invoke({ messages: [new HumanMessage(`hi ${i}`)] }, config);
    }
    // Inspect every stored checkpoint: messages must never appear as a plain
    // accumulated value (only absent, since snapshotFrequency=1000).
    let sawPopulated = false;
    for await (const tup of saver.list(config)) {
      const cv = tup.checkpoint.channel_values as Record<string, unknown>;
      if ("messages" in cv && cv.messages !== undefined) {
        sawPopulated = true;
        expect(isDeltaSnapshot(cv.messages)).toBe(true);
      }
    }
    expect(sawPopulated).toBe(false);
  });

  it("writes periodic snapshots and bounds replay depth", async () => {
    const graph = buildGraph(2);
    const saver = (graph as unknown as { checkpointer: MemorySaver })
      .checkpointer;
    const config = { configurable: { thread_id: "thread-snap" } };
    for (let i = 0; i < 6; i += 1) {
      await graph.invoke({ messages: [new HumanMessage(`hi ${i}`)] }, config);
    }
    // At least one checkpoint must store a DeltaSnapshot blob.
    let snapshots = 0;
    for await (const tup of saver.list(config)) {
      const cv = tup.checkpoint.channel_values as Record<string, unknown>;
      if (isDeltaSnapshot(cv.messages)) snapshots += 1;
    }
    expect(snapshots).toBeGreaterThan(0);

    const state = await graph.getState(config);
    const contents = (state.values as { messages: BaseMessage[] }).messages.map(
      (m) => m.content
    );
    // 6 human + 6 replies = 12 messages reconstructed correctly.
    expect(contents).toHaveLength(12);
    expect(contents[0]).toBe("hi 0");
    expect(contents[contents.length - 1]).toBe("reply 6");
  });

  it("reconstructs from a fresh graph instance (cold read)", async () => {
    const saver = new MemorySaver();
    const State = Annotation.Root({
      messages: new DeltaChannel<BaseMessage[], Messages>(messagesDeltaReducer),
    });
    let turn = 0;
    const makeGraph = () =>
      new StateGraph(State)
        .addNode("chat", () => {
          turn += 1;
          return { messages: [new AIMessage({ content: `r${turn}` })] };
        })
        .addEdge(START, "chat")
        .addEdge("chat", END)
        .compile({ checkpointer: saver });

    const config = { configurable: { thread_id: "cold" } };
    await makeGraph().invoke({ messages: [new HumanMessage("first")] }, config);
    await makeGraph().invoke({ messages: [new HumanMessage("second")] }, config);

    // brand new compiled graph sharing only the saver
    const fresh = makeGraph();
    const state = await fresh.getState(config);
    const contents = (state.values as { messages: BaseMessage[] }).messages.map(
      (m) => m.content
    );
    expect(contents).toEqual(["first", "r1", "second", "r2"]);
    // ids are stable across reconstruction reads
    const second = await fresh.getState(config);
    expect((second.values as { messages: BaseMessage[] }).messages.map((m) => m.id)).toEqual(
      (state.values as { messages: BaseMessage[] }).messages.map((m) => m.id)
    );
  });
});

describe("channelsFromCheckpoint", () => {
  it("replays writes for absent delta channels using the saver", async () => {
    const saver = new MemorySaver();
    const cfg = { configurable: { thread_id: "cfc", checkpoint_ns: "" } };
    const meta: CheckpointMetadata = { source: "loop", step: 0, parents: {} };
    const cp0: Checkpoint = {
      ...emptyCheckpoint(),
      id: "00000000-0000-0000-0000-0000000000b0",
      channel_values: { messages: new DeltaSnapshot([1]) },
      channel_versions: { messages: 1 },
    };
    const c0 = await saver.put(cfg, cp0, meta);
    await saver.putWrites(c0, [["messages", [2]]], "task0");
    const cp1: Checkpoint = {
      ...emptyCheckpoint(),
      id: "00000000-0000-0000-0000-0000000000b1",
      channel_values: {},
      channel_versions: { messages: 2 },
    };
    const c1 = await saver.put(c0, cp1, meta);

    const specs = {
      messages: new DeltaChannel<number[], number[]>(listReducer),
    };
    const channels = await channelsFromCheckpoint(specs, cp1, {
      saver,
      config: c1,
    });
    expect(channels.messages.get()).toEqual([1, 2]);
  });
});

describe("DELTA_MAX_SUPERSTEPS_SINCE_SNAPSHOT", () => {
  const ENV = "LANGGRAPH_DELTA_MAX_SUPERSTEPS_SINCE_SNAPSHOT";
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env[ENV];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[ENV];
    else process.env[ENV] = prev;
  });

  it("forces a snapshot once the superstep bound is reached even with no writes", async () => {
    process.env[ENV] = "2";
    const State = Annotation.Root({
      counter: new DeltaChannel<number[], number[]>((s, w) =>
        listReducer(s, w)
      ),
      tick: Annotation<number>({ reducer: (a, b) => (b ?? a) ?? 0, default: () => 0 }),
    });
    // counter is written once, then idle; tick keeps the graph stepping.
    const graph = new StateGraph(State)
      .addNode("seed", () => ({ counter: [1] }))
      .addNode("idle", (s: { tick: number }) => ({ tick: (s.tick ?? 0) + 1 }))
      .addEdge(START, "seed")
      .addEdge("seed", "idle")
      .addEdge("idle", END)
      .compile({ checkpointer: new MemorySaver() });
    const saver = (graph as unknown as { checkpointer: MemorySaver })
      .checkpointer;
    const config = { configurable: { thread_id: "bound" } };
    for (let i = 0; i < 4; i += 1) await graph.invoke({}, config);

    let snapshots = 0;
    for await (const tup of saver.list(config)) {
      const cv = tup.checkpoint.channel_values as Record<string, unknown>;
      if (isDeltaSnapshot(cv.counter)) snapshots += 1;
    }
    expect(snapshots).toBeGreaterThan(0);
    const state = await graph.getState(config);
    // counter is written once per invoke (4 invokes), and reconstruction
    // remains correct despite forced snapshots from the superstep bound.
    expect((state.values as { counter: number[] }).counter).toEqual([1, 1, 1, 1]);
  });
});
