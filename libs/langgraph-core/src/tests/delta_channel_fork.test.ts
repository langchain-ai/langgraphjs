import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  MemorySaver,
  type BaseCheckpointSaver,
  isDeltaSnapshot,
} from "@langchain/langgraph-checkpoint";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { DeltaChannel } from "../channels/delta.js";
import { deltaChannelsToSnapshot } from "../channels/base.js";
import { LastValue } from "../channels/last_value.js";
import { EphemeralValue } from "../channels/ephemeral_value.js";
import { messagesDeltaReducer, type Messages } from "../graph/messages_reducer.js";
import { Annotation } from "../graph/index.js";
import { StateGraph } from "../graph/state.js";
import { Channel, Pregel } from "../pregel/index.js";
import type { StateSnapshot } from "../pregel/types.js";
import { START, END, INPUT, COPY, Command, Send } from "../constants.js";
import { interrupt } from "../interrupt.js";

const append = (state: string[], writes: (string | string[])[]): string[] => {
  const out = [...state];
  for (const write of writes) out.push(...(Array.isArray(write) ? write : [write]));
  return out;
};
const concat = (a: string[], b: string[]) => [...a, ...b];

const State = Annotation.Root({
  log: new DeltaChannel<string[], string | string[]>(append),
  plain: Annotation<string[]>({ reducer: concat, default: () => [] }),
  other: Annotation<string[]>({ reducer: concat, default: () => [] }),
});
type Values = typeof State.State;

const durabilities = ["sync", "async", "exit"] as const;
const savers: [string, () => BaseCheckpointSaver][] = [
  ["MemorySaver", () => new MemorySaver()],
  ["SqliteSaver", () => SqliteSaver.fromConnString(":memory:")],
];

const both = (marker: string) => ({ log: [marker], plain: [marker] });

const thread = (threadId: string): RunnableConfig => ({
  configurable: { thread_id: threadId },
});

const at = (config: RunnableConfig, snapshot: StateSnapshot): RunnableConfig => ({
  configurable: {
    ...config.configurable,
    checkpoint_ns: "",
    checkpoint_id: snapshot.config.configurable?.checkpoint_id,
  },
});

type HasHistory = {
  getStateHistory(config: RunnableConfig): AsyncIterableIterator<StateSnapshot>;
};

const history = async (graph: HasHistory, config: RunnableConfig) => {
  const out: StateSnapshot[] = [];
  for await (const snapshot of graph.getStateHistory(config)) out.push(snapshot);
  return out;
};

const newest = async (
  graph: HasHistory,
  config: RunnableConfig,
  matches: (snapshot: StateSnapshot) => boolean
) => {
  const found = (await history(graph, config)).find(matches);
  if (found === undefined) throw new Error("no checkpoint in the history matched");
  return found;
};

const withoutIn2 = (snapshot: StateSnapshot) =>
  !(snapshot.values as Values).log.includes("in-2");

const snapshottedCheckpoints = async (
  saver: BaseCheckpointSaver,
  config: RunnableConfig
) => {
  const ids: string[] = [];
  for await (const tuple of saver.list(config)) {
    if (isDeltaSnapshot(tuple.checkpoint.channel_values.log)) {
      ids.push(tuple.config.configurable?.checkpoint_id);
    }
  }
  return ids;
};

const expectForkIsClean = (state: StateSnapshot, abandoned: string) => {
  const { log, plain } = state.values as Values;
  expect(log, "delta channel diverged from the plain channel").toEqual(plain);
  expect(
    log,
    `${abandoned} belongs to the branch the fork replaced, but was replayed`
  ).not.toContain(abandoned);
};

const expectBoth = (values: Values, expected: string[], message?: string) =>
  expect({ log: values.log, plain: values.plain }, message).toEqual({
    log: expected,
    plain: expected,
  });

const sorted = (values: string[]) => [...values].sort();

const expectBranchUnchanged = (
  state: StateSnapshot,
  expected: string[],
  edit: string
) =>
  expectBoth(
    state.values as Values,
    expected,
    `${edit} was written by an updateState on this branch's base`
  );

const build = (saver: BaseCheckpointSaver, tag: string) =>
  new StateGraph(State)
    .addNode("n", () => both(`${tag}-out`))
    .addEdge(START, "n")
    .addEdge("n", END)
    .compile({ checkpointer: saver });

const buildWithoutDeltaWrites = (saver: BaseCheckpointSaver, tag: string) =>
  new StateGraph(State)
    .addNode("n", () => ({ other: [`${tag}-other`] }))
    .addEdge(START, "n")
    .addEdge("n", END)
    .compile({ checkpointer: saver });

const buildTwoSteps = (saver: BaseCheckpointSaver, subgraph: boolean) => {
  const inner = new StateGraph(State)
    .addNode("b1", () => both("b1"))
    .addNode("b2", () => both("b2"))
    .addEdge(START, "b1")
    .addEdge("b1", "b2")
    .compile();
  return new StateGraph(State)
    .addNode("a", () => both("a"))
    .addNode("b", subgraph ? inner : () => both("b"))
    .addEdge(START, "a")
    .addEdge("a", "b")
    .compile({ checkpointer: saver });
};

const buildPausedBeforeB = (saver: BaseCheckpointSaver) =>
  new StateGraph(State)
    .addNode("a", () => both("a"))
    .addNode("b", () => both("b"))
    .addEdge(START, "a")
    .addEdge("a", "b")
    .addEdge("b", END)
    .compile({ checkpointer: saver, interruptBefore: ["b"] });

const buildParallelInterrupt = (saver: BaseCheckpointSaver) =>
  new StateGraph(State)
    .addNode("p", () => both("p"))
    .addNode("q", () => {
      interrupt("approve?");
      return { other: ["q"] };
    })
    .addEdge(START, "p")
    .addEdge(START, "q")
    .compile({ checkpointer: saver });

const buildDeferredAfterInterrupt = (saver: BaseCheckpointSaver) =>
  new StateGraph(State)
    .addNode("a", () => both("a"))
    .addNode("b", () => both("b"), { defer: true })
    .addNode("c", () => ({}))
    .addEdge(START, "a")
    .addEdge("a", "b")
    .addEdge("a", "c")
    .compile({ checkpointer: saver, interruptAfter: ["a"] });

const buildSendFanOut = (saver: BaseCheckpointSaver) =>
  new StateGraph(State)
    .addNode("p", () => both("p"))
    .addNode("q", () => {
      interrupt("continue?");
      return both("q");
    })
    .addConditionalEdges(
      START,
      (state: Values) => [new Send("p", state), new Send("q", state)],
      ["p", "q"]
    )
    .compile({ checkpointer: saver });

describe.each(savers)("DeltaChannel fork (%s)", (_name, makeSaver) => {
  it.each(durabilities)("fork by invoke (durability=%s)", async (durability) => {
    const saver = makeSaver();
    const config = thread("t");
    await build(saver, "first").invoke(both("in-1"), { ...config, durability });
    const graph = build(saver, "second");
    await graph.invoke(both("in-2"), { ...config, durability });
    const abandonedHead = await graph.getState(config);

    const base = await newest(graph, config, withoutIn2);
    await build(saver, "third").invoke(both("in-3"), {
      ...at(config, base),
      durability,
    });

    const state = await graph.getState(config);
    expectForkIsClean(state, "in-2");
    expect(state.values.log).toEqual([...base.values.log, "in-3", "third-out"]);

    const abandoned = (await graph.getState(abandonedHead.config)).values;
    expectBoth(abandoned, abandonedHead.values.log);
  });

  it.each(durabilities)(
    "fork off the checkpoint before the first input (durability=%s)",
    async (durability) => {
      const saver = makeSaver();
      const config = thread("t");
      const graph = build(saver, "first");
      await graph.invoke(both("in-1"), { ...config, durability });

      const root = (await history(graph, config)).at(-1)!;
      expect(root.values.log).toEqual([]);

      await build(saver, "third").invoke(both("in-9"), {
        ...at(config, root),
        durability,
      });

      const state = await graph.getState(config);
      expectForkIsClean(state, "in-1");
      expect(state.values.log).toEqual(["in-9", "third-out"]);
    }
  );

  it("fork by updateState", async () => {
    const saver = makeSaver();
    const config = thread("t");
    await build(saver, "first").invoke(both("in-1"), config);
    const graph = build(saver, "second");
    await graph.invoke(both("in-2"), config);

    const base = await newest(graph, config, withoutIn2);
    const forked = await graph.updateState(at(config, base), both("patched"));

    const state = await graph.getState(forked);
    expectForkIsClean(state, "in-2");
    expect(state.values.log).toEqual([...base.values.log, "patched"]);
  });

  it("a retry after a failed exit-mode save doesn't replay the failed run's writes", async () => {
    const saver = makeSaver();
    const put = saver.put.bind(saver);
    let failNextPut = false;
    saver.put = async (...args: Parameters<typeof put>) => {
      if (failNextPut) {
        failNextPut = false;
        throw new Error("put failed");
      }
      return put(...args);
    };
    const graph = new StateGraph(State)
      .addNode("a", () => both("a"))
      .addNode("b", () => both("b"))
      .addEdge(START, "a")
      .addEdge("a", "b")
      .compile({ checkpointer: saver });
    const config = { ...thread("t"), durability: "exit" as const };
    await graph.invoke(both("in-1"), config);
    failNextPut = true;
    await expect(graph.invoke(both("in-2"), config)).rejects.toThrow(
      "put failed"
    );

    await graph.invoke(both("in-3"), config);

    const { log, plain } = (await graph.getState(thread("t"))).values as Values;
    expect(log).toEqual(plain);
  });

  const forkFromRoot = async () => {
    const saver = makeSaver();
    const config = thread("t");
    const graph = build(saver, "orig");
    await graph.invoke(both("human1"), config);
    const original = await graph.getState(config);
    const firstWithState = (await history(graph, config))
      .reverse()
      .find((snapshot) => (snapshot.values as Values).log.length > 0);
    const root: RunnableConfig = {
      configurable: {
        ...config.configurable,
        checkpoint_ns: "",
        checkpoint_id: firstWithState?.parentConfig?.configurable?.checkpoint_id,
      },
    };
    const forked = await graph.updateState(root, both("fork1"), START);
    return { graph, original, firstWithState: firstWithState!, forked };
  };

  it("updateState forking from the root checkpoint reads only its own write", async () => {
    const { graph, forked } = await forkFromRoot();

    expectBoth((await graph.getState(forked)).values as Values, ["fork1"]);
  });

  it("updateState forking from the root checkpoint leaves the original branch alone", async () => {
    const { graph, original, firstWithState } = await forkFromRoot();

    expectBoth(
      (await graph.getState(firstWithState.config)).values as Values,
      (firstWithState.values as Values).log
    );
    expectBoth(
      (await graph.getState(original.config)).values as Values,
      ["human1", "orig-out"]
    );
  });

  it("a fork from the root checkpoint stays apart after resuming it", async () => {
    const { graph, original, forked } = await forkFromRoot();

    await graph.invoke(null, forked);

    expectBoth((await graph.getState(forked)).values as Values, ["fork1"]);
    expectBoth(
      (await graph.getState(original.config)).values as Values,
      ["human1", "orig-out"]
    );
  });

  it("fork by an updateState with no values", async () => {
    const saver = makeSaver();
    const config = thread("t");
    await build(saver, "first").invoke(both("in-1"), config);
    const graph = build(saver, "second");
    await graph.invoke(both("in-2"), config);

    const base = await newest(graph, config, withoutIn2);
    const forked = await graph.updateState(at(config, base), undefined);

    const state = await graph.getState(forked);
    expectForkIsClean(state, "in-2");
    expect(state.values.log).toEqual(base.values.log);
  });

  // The old checkpoint is either a finished turn, which saved no writes, or one
  // whose next node already ran there and left its writes on it.
  it.each([false, true])(
    "updateState on an old checkpoint leaves its other branch alone (nextNodeRan=%s)",
    async (nextNodeRan) => {
      const saver = makeSaver();
      const config = thread("t");
      const graph = build(saver, "first");
      await graph.invoke(both("in-1"), config);
      await build(saver, "second").invoke(both("in-2"), config);
      const branch = await graph.getState(config);
      const base = await newest(
        graph,
        config,
        (s) =>
          withoutIn2(s) &&
          JSON.stringify(s.next) === JSON.stringify(nextNodeRan ? ["n"] : [])
      );

      const edited = await graph.updateState(at(config, base), both("edit"), "n");

      expectBranchUnchanged(
        await graph.getState(branch.config),
        branch.values.log,
        "edit"
      );
      expect((await graph.getState(edited)).values.log).toEqual([
        ...base.values.log,
        "edit",
      ]);

      await build(saver, "third").invoke(both("in-3"), branch.config);
      expectBranchUnchanged(
        await graph.getState(config),
        [...branch.values.log, "in-3", "third-out"],
        "edit"
      );
    }
  );

  it("bulkUpdateState on an old checkpoint leaves its other branch alone", async () => {
    const saver = makeSaver();
    const config = thread("t");
    const graph = build(saver, "first");
    await graph.invoke(both("in-1"), config);
    const base = await graph.getState(config);
    await build(saver, "second").invoke(both("in-2"), config);
    const branch = await graph.getState(config);

    const edited = await graph.bulkUpdateState(at(config, base), [
      { updates: [{ values: both("s1"), asNode: "n" }] },
      { updates: [{ values: both("s2"), asNode: "n" }] },
    ]);

    expectBranchUnchanged(
      await graph.getState(branch.config),
      branch.values.log,
      "s1"
    );
    expect((await graph.getState(edited)).values.log).toEqual([
      ...base.values.log,
      "s1",
      "s2",
    ]);
  });

  it.each([
    { id: "delta_and_plain", edit: both("edit") },
    { id: "plain_only", edit: { other: ["edit"] } },
  ])(
    "clearing an old checkpoint does not pick up an edit of it ($id)",
    async ({ edit }) => {
      const graph = new StateGraph(State)
        .addNode("a", () => both("a"))
        .addNode("b", () => both("b"))
        .addEdge(START, "a")
        .addEdge("a", "b")
        .compile({ checkpointer: makeSaver() });
      const config = thread("t");
      await graph.invoke(both("in"), { ...config, interruptBefore: ["b"] });
      const base = await graph.getState(config);
      await graph.updateState(config, both("later"), "a");
      await graph.updateState(base.config, edit, "b");

      const cleared = await graph.updateState(base.config, null, END);

      const { values } = await graph.getState(cleared);
      expectBoth(values, ["in", "a"]);
      expect(values.other).toEqual([]);
    }
  );

  it("clearing a checkpoint after editing it reads the same in both channels", async () => {
    const graph = new StateGraph(State)
      .addNode("p", () => both("p"))
      .addNode("q", () => {
        interrupt("continue?");
        return both("q");
      })
      .addEdge(START, "p")
      .addEdge(START, "q")
      .compile({ checkpointer: makeSaver() });
    const config = thread("t");
    await graph.invoke(both("in"), config);
    const head = await graph.getState(config);
    await graph.updateState(head.config, both("edit"), "q");

    const cleared = await graph.updateState(head.config, null, END);

    const { log, plain } = (await graph.getState(cleared)).values as Values;
    expect(log).toEqual(plain);
  });

  it("updateState with the head checkpoint id stores no snapshot", async () => {
    const saver = makeSaver();
    const config = thread("t");
    const graph = build(saver, "first");
    await graph.invoke(both("in-1"), config);
    for (let i = 0; i < 3; i += 1) {
      await graph.updateState((await graph.getState(config)).config, both(`u${i}`));
    }

    expect(await snapshottedCheckpoints(saver, config)).toEqual([]);
    expect((await graph.getState(config)).values.log).toEqual([
      "in-1",
      "first-out",
      "u0",
      "u1",
      "u2",
    ]);
  });

  it.each(durabilities)(
    "unaddressed run keeps the snapshot cadence (durability=%s)",
    async (durability) => {
      const saver = makeSaver();
      const config = thread("t");
      const graph = build(saver, "first");
      await graph.invoke(both("in-1"), { ...config, durability });
      await graph.invoke(both("in-2"), { ...config, durability });

      expect(await snapshottedCheckpoints(saver, config)).toEqual([]);
    }
  );

  it.each(durabilities)(
    "fork before the first value when the fork never writes the channel (durability=%s)",
    async (durability) => {
      const saver = makeSaver();
      const config = thread("t");
      const graph = build(saver, "first");
      await graph.invoke(both("in-1"), { ...config, durability });

      const root = (await history(graph, config)).at(-1)!;
      expect(root.values.log).toEqual([]);

      await buildWithoutDeltaWrites(saver, "third").invoke(
        { other: ["in-9"] },
        { ...at(config, root), durability }
      );

      const state = await graph.getState(config);
      expectForkIsClean(state, "in-1");
      expect(state.values.log).toEqual([]);
    }
  );

  it("fork before the first value by bulkUpdateState", async () => {
    const saver = makeSaver();
    const config = thread("t");
    const graph = build(saver, "first");
    await graph.invoke(both("in-1"), config);

    const root = (await history(graph, config)).at(-1)!;
    expect(root.values.log).toEqual([]);

    const forked = await graph.bulkUpdateState(at(config, root), [
      { updates: [{ values: { other: ["s1"] }, asNode: "n" }] },
      { updates: [{ values: both("s2"), asNode: "n" }] },
    ]);

    const state = await graph.getState(forked);
    expectForkIsClean(state, "in-1");
    expect(state.values.log).toEqual(["s2"]);
  });

  it.each([INPUT, END, COPY])(
    "fork by bulkUpdateState whose first superstep is not a node (firstAsNode=%s)",
    async (firstAsNode) => {
      const saver = makeSaver();
      const config = thread("t");
      await build(saver, "first").invoke(both("in-1"), config);
      const graph = build(saver, "second");
      await graph.invoke(both("in-2"), config);

      const base = await newest(graph, config, withoutIn2);
      const first =
        firstAsNode === INPUT
          ? { values: both("first-step"), asNode: firstAsNode }
          : { values: null, asNode: firstAsNode };
      const forked = await graph.bulkUpdateState(at(config, base), [
        { updates: [first] },
        { updates: [{ values: both("second-step"), asNode: "n" }] },
      ]);

      const { values } = await graph.getState(forked);
      expect(values.log, "delta channel diverged from the plain channel").toEqual(
        values.plain
      );
    }
  );

  it("bulkUpdateState after a copy stores no snapshot", async () => {
    const saver = makeSaver();
    const config = thread("t");
    await build(saver, "first").invoke(both("in-1"), config);
    const graph = build(saver, "second");
    await graph.invoke(both("in-2"), config);
    const base = await newest(graph, config, withoutIn2);

    const forked = await graph.bulkUpdateState(at(config, base), [
      { updates: [{ values: null, asNode: COPY }] },
      { updates: [{ values: both("s2"), asNode: "n" }] },
    ]);

    expect((await graph.getState(forked)).values.log).toEqual([
      "in-1",
      "first-out",
      "s2",
    ]);
    expect(await snapshottedCheckpoints(saver, config)).toEqual([]);
  });

  it("unaddressed bulkUpdateState keeps the snapshot cadence", async () => {
    const saver = makeSaver();
    const config = thread("t");
    const graph = build(saver, "first");
    await graph.invoke(both("in-1"), config);

    await graph.bulkUpdateState(
      config,
      [0, 1, 2, 3].map((i) => ({
        updates: [{ values: both(`u${i}`), asNode: "n" }],
      }))
    );

    expect(await snapshottedCheckpoints(saver, config)).toEqual([]);
  });

  it.each(
    durabilities.flatMap((durability) =>
      [false, true].flatMap((subgraph) =>
        ["none", "command"].map((replayInput) => ({
          durability,
          subgraph,
          replayInput,
        }))
      )
    )
  )(
    "replay from an edit the thread moved past leaves its branch alone (durability=$durability, subgraph=$subgraph, input=$replayInput)",
    async ({ durability, subgraph, replayInput }) => {
      const graph = buildTwoSteps(makeSaver(), subgraph);
      const config = thread("t");
      await graph.invoke(both("in-1"), { ...config, durability });
      const edit = await graph.updateState(config, both("edit"), "a");
      await graph.invoke(both("in-2"), { ...config, durability });
      const branch = await graph.getState(config);

      await graph.invoke(
        replayInput === "command" ? new Command({ update: both("cmd") }) : null,
        { ...edit, durability }
      );

      expectBoth(
        (await graph.getState(branch.config)).values,
        branch.values.log,
        "a replay from the edit wrote into the branch that already grew from it"
      );
      const replay = (await graph.getState(config)).values;
      expect(replay.log).toEqual(replay.plain);
    }
  );

  it.each(
    durabilities.flatMap((durability) =>
      ["update", "goto"].map((command) => ({ durability, command }))
    )
  )(
    "Command replay of an old checkpoint stores nothing on it (durability=$durability, command=$command)",
    async ({ durability, command }) => {
      const graph = buildTwoSteps(makeSaver(), false);
      const config = thread("t");
      await graph.invoke(both("in"), {
        ...config,
        interruptBefore: ["b"],
        durability,
      });
      const old = await graph.getState(config);
      await graph.invoke(null, { ...config, durability });
      const branch = await graph.getState(config);

      await graph.invoke(
        command === "update"
          ? new Command({ update: both("cmd") })
          : new Command({ goto: "a" }),
        { ...old.config, durability }
      );

      expectBoth((await graph.getState(branch.config)).values, branch.values.log);
      await graph.invoke(null, { ...old.config, durability });
      expectBoth(
        (await graph.getState(config)).values,
        ["in", "a", "b"],
        "a later replay of the checkpoint repeated the earlier Command"
      );
    }
  );

  it.each(durabilities)(
    "resume at interruptBefore with the head checkpoint id runs the node (durability=%s)",
    async (durability) => {
      const config = thread("t");
      const graph = buildPausedBeforeB(makeSaver());
      await graph.invoke(both("in"), { ...config, durability });

      await graph.invoke(null, {
        ...(await graph.getState(config)).config,
        durability,
      });

      const state = await graph.getState(config);
      expect(state.next, "resume paused again").toEqual([]);
      expectBoth(state.values, ["in", "a", "b"]);
    }
  );

  it("replay from a paused checkpoint runs the node once", async () => {
    const config = thread("t");
    const graph = buildPausedBeforeB(makeSaver());
    await graph.invoke(both("in"), config);
    const paused = (await graph.getState(config)).config;
    await graph.invoke(null, config);

    await graph.invoke(null, paused);

    const state = await graph.getState(config);
    expect(state.next, "replay paused again").toEqual([]);
    expectBoth(state.values, ["in", "a", "b"]);
  });

  it.each(
    durabilities.flatMap((durability) =>
      [false, true].map((addressed) => ({ durability, addressed }))
    )
  )(
    "new input on an interrupted head does not replay its pending writes (durability=$durability, addressed=$addressed)",
    async ({ durability, addressed }) => {
      const config = thread("t");
      const graph = buildParallelInterrupt(makeSaver());
      await graph.invoke(both("in-1"), { ...config, durability });
      const head = (await graph.getState(config)).config;

      await graph.invoke(both("in-2"), {
        ...(addressed ? head : config),
        durability,
      });

      expectBoth((await graph.getState(config)).values, ["in-1", "in-2", "p"]);
    }
  );

  const resumeOnInterruptedHead = async (
    durability: (typeof durabilities)[number]
  ) => {
    const saver = makeSaver();
    const config = thread("t");
    const graph = buildParallelInterrupt(saver);
    await graph.invoke(both("in-1"), { ...config, durability });

    await graph.invoke(new Command({ resume: "yes" }), { ...config, durability });

    const state = await graph.getState(config);
    expect(state.next).toEqual([]);
    expectBoth(state.values, ["in-1", "p"]);
    expect(await snapshottedCheckpoints(saver, config)).toEqual([]);
  };
  it.each(durabilities)(
    "resume on an interrupted head consumes its writes without a snapshot (durability=%s)",
    resumeOnInterruptedHead
  );

  it.each(durabilities)(
    "resume whose node writes the delta channel stores no snapshot (durability=%s)",
    async (durability) => {
      const saver = makeSaver();
      const graph = new StateGraph(State)
        .addNode("ask", () => both(interrupt("continue?")))
        .addEdge(START, "ask")
        .compile({ checkpointer: saver });
      const config = thread("t");
      await graph.invoke(both("in"), { ...config, durability });

      await graph.invoke(new Command({ resume: "yes" }), { ...config, durability });

      expectBoth((await graph.getState(config)).values, ["in", "yes"]);
      expect(await snapshottedCheckpoints(saver, config)).toEqual([]);
    }
  );

  it.each(durabilities)(
    "resume after interruptBefore stores no snapshot (durability=%s)",
    async (durability) => {
      const saver = makeSaver();
      const config = thread("t");
      const graph = build(saver, "n");
      await graph.invoke(both("in"), {
        ...config,
        interruptBefore: ["n"],
        durability,
      });

      await graph.invoke(null, { ...config, durability });

      expectBoth((await graph.getState(config)).values, ["in", "n-out"]);
      expect(await snapshottedCheckpoints(saver, config)).toEqual([]);
    }
  );

  it.each(durabilities)(
    "resume that replaces the pending Sends drops the finished task (durability=%s)",
    async (durability) => {
      const graph = buildSendFanOut(makeSaver());
      const config = thread("t");
      await graph.invoke(both("in"), { ...config, durability });

      const live = await graph.invoke(
        new Command({ resume: "yes", goto: [new Send("q", both("unused"))] }),
        { ...config, durability }
      );

      const { values } = await graph.getState(config);
      expect(
        { log: sorted(values.log), plain: sorted(values.plain) },
        "'p' ran in the fan-out the resume replaced, but the reload differs from the live run"
      ).toEqual({ log: sorted(live.log), plain: sorted(live.log) });
    }
  );

  it.each(durabilities)(
    "replay interrupted in its first step still seals the fork (durability=%s)",
    async (durability) => {
      const graph = buildSendFanOut(makeSaver());
      const config = thread("t");
      await graph.invoke(both("in"), { ...config, durability });

      await graph.invoke(null, {
        ...(await graph.getState(config)).config,
        durability,
      });

      expectBoth(
        (await graph.getState(config)).values,
        ["in", "p"],
        "the replay reran p, so the fork must not also replay the first p"
      );
    }
  );

  it.each(durabilities)(
    "resume addressed at an interrupted head reruns its tasks once (durability=%s)",
    async (durability) => {
      const config = thread("t");
      const graph = buildParallelInterrupt(makeSaver());
      await graph.invoke(both("in-1"), { ...config, durability });

      await graph.invoke(new Command({ resume: "yes" }), {
        ...(await graph.getState(config)).config,
        durability,
      });

      const state = await graph.getState(config);
      expect(state.next).toEqual([]);
      expectBoth(state.values, ["in-1", "p"]);
    }
  );

  it("updateState with the head checkpoint id keeps a deferred node", async () => {
    const graph = buildDeferredAfterInterrupt(makeSaver());
    const config = thread("t");
    await graph.invoke(both("in"), config);

    await graph.updateState((await graph.getState(config)).config, both("u"), "c");
    await graph.invoke(null, config);

    const state = await graph.getState(config);
    expect(state.next, "deferred node never ran").toEqual([]);
    expectBoth(state.values, ["in", "a", "u", "b"]);
  });

  it("turns addressed at the head store no snapshot", async () => {
    const saver = makeSaver();
    const config = thread("t");
    const graph = build(saver, "turn");
    await graph.invoke(both("in-1"), config);
    for (let turn = 2; turn < 5; turn += 1) {
      await graph.invoke(both(`in-${turn}`), (await graph.getState(config)).config);
    }

    expect(await snapshottedCheckpoints(saver, config)).toEqual([]);
    const { values } = await graph.getState(config);
    expect(values.log).toEqual(values.plain);
  });

  it.each(durabilities)(
    "resume that reruns an error handler drops its stored writes (durability=%s)",
    async (durability) => {
      let markHandled!: () => void;
      const handled = new Promise<void>((resolve) => {
        markHandled = resolve;
      });
      let attempts = 0;
      const graph = new StateGraph(State)
        .addNode(
          "f",
          (): Partial<Values> => {
            throw new Error("f always fails");
          },
          {
            errorHandler: () => {
              markHandled();
              return both("h");
            },
          }
        )
        .addNode("c", async () => {
          attempts += 1;
          if (attempts === 1) {
            await handled;
            throw new Error("c fails once");
          }
          return both("c");
        })
        .addEdge(START, "f")
        .addEdge(START, "c")
        .compile({ checkpointer: makeSaver() });
      const config = thread("t");
      await expect(
        graph.invoke(both("in"), { ...config, durability })
      ).rejects.toThrow("c fails once");

      const live = await graph.invoke(null, { ...config, durability });

      const { values } = await graph.getState(config);
      expect({ log: sorted(values.log), plain: sorted(values.plain) }).toEqual({
        log: sorted(live.log),
        plain: sorted(live.log),
      });
    }
  );
});

describe("DeltaChannel updateState (from langgraph#8548)", () => {
  it("a fresh updateState stores nothing for a delta channel it did not write", async () => {
    const saver = new MemorySaver();
    const graph = new StateGraph(
      Annotation.Root({
        messages: new DeltaChannel<BaseMessage[], Messages>(messagesDeltaReducer),
        notes: new DeltaChannel<BaseMessage[], Messages>(messagesDeltaReducer),
      })
    )
      .addNode("model", () => ({}))
      .addEdge(START, "model")
      .compile({ checkpointer: saver });
    const config = thread("fresh-unwritten");

    await graph.updateState(
      config,
      { messages: [new HumanMessage({ content: "hello", id: "m1" })] },
      "model"
    );

    const head = await saver.getTuple(config);
    expect(head).toBeDefined();
    expect(head!.checkpoint.channel_versions.notes).toBeUndefined();
    expect((await graph.getState(config)).values.notes).toEqual([]);
  });

  it("updateState that snapshots keeps a deferred node pending", async () => {
    const message = (content: string) => new HumanMessage({ content, id: content });
    const graph = new StateGraph(
      Annotation.Root({
        messages: new DeltaChannel<BaseMessage[], Messages>(messagesDeltaReducer, {
          snapshotFrequency: 1,
        }),
      })
    )
      .addNode("a", () => ({ messages: [message("a")] }))
      .addNode("b", () => ({ messages: [message("b")] }), { defer: true })
      .addNode("c", () => ({}))
      .addEdge(START, "a")
      .addEdge("a", "b")
      .addEdge("a", "c")
      .compile({ checkpointer: new MemorySaver(), interruptAfter: ["a"] });
    const config = thread("t");
    await graph.invoke({ messages: [message("s")] }, config);

    await graph.updateState(config, { messages: [message("u")] }, "c");
    const final = await graph.invoke(null, config);

    expect(final.messages.map((m: BaseMessage) => m.content)).toEqual([
      "s",
      "a",
      "u",
      "b",
    ]);
    expect((await graph.getState(config)).next).toEqual([]);
  });
});

describe("DeltaChannel supersteps bound (from langgraph#8548)", () => {
  const ENV = "LANGGRAPH_DELTA_MAX_SUPERSTEPS_SINCE_SNAPSHOT";
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env[ENV];
    delete process.env[ENV];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[ENV];
    else process.env[ENV] = prev;
  });

  it("the supersteps bound skips a channel never written", async () => {
    process.env[ENV] = "3";
    const saver = new MemorySaver();
    const builder = new StateGraph(
      Annotation.Root({
        a: new DeltaChannel<string[], string | string[]>(append, {
          snapshotFrequency: 10_000,
        }),
        b: new DeltaChannel<string[], string | string[]>(append, {
          snapshotFrequency: 10_000,
        }),
      })
    );
    const names = [0, 1, 2, 3].map((i) => `step_${i}`);
    names.forEach((name, i) => builder.addNode(name, () => ({ a: [`a-val-${i}`] })));
    [START, ...names, END].forEach((from, i, all) => {
      if (i < all.length - 1) builder.addEdge(from as never, all[i + 1] as never);
    });
    const graph = builder.compile({ checkpointer: saver });
    const config = thread("never-written");

    await graph.invoke({ a: ["seed-a"] }, config);

    const minted: string[] = [];
    for await (const tuple of saver.list(config)) {
      if ("b" in tuple.checkpoint.channel_versions) {
        minted.push(tuple.config.configurable?.checkpoint_id);
      }
    }
    expect(minted, "b was never written, but checkpoints minted it a version").toEqual(
      []
    );
    expect((await graph.getState(config)).values.b).toEqual([]);
  });

  it("the predicate fires on supersteps overflow", () => {
    const channels = {
      x: new DeltaChannel<string[], string | string[]>(append, {
        snapshotFrequency: 10_000,
      }).fromCheckpoint(undefined),
    };

    expect(deltaChannelsToSnapshot(channels, { x: [0, 5000] }, { x: 1 }).has("x")).toBe(
      true
    );
    expect(deltaChannelsToSnapshot(channels, { x: [0, 4999] }, { x: 1 }).has("x")).toBe(
      false
    );
    expect(
      deltaChannelsToSnapshot(channels, { x: [0, 5000] }, {}).size,
      "a channel with no version was never written, so it has nothing to snapshot"
    ).toBe(0);
  });
});

describe("updateState asNode inference (from langgraph#8548)", () => {
  const extend = (state: string[], writes: string[][]) => [
    ...state,
    ...writes.flat(),
  ];
  const config = thread("t");

  const chainAfterADeltaChannel = () =>
    new Pregel({
      nodes: {
        a: Channel.subscribeTo("inp")
          .pipe(() => ["a"])
          .pipe(Channel.writeTo(["d"])),
        b: Channel.subscribeTo("d")
          .pipe(() => "b")
          .pipe(Channel.writeTo(["x"])),
        c: Channel.subscribeTo("x")
          .pipe(() => "c")
          .pipe(Channel.writeTo(["out"])),
      },
      channels: {
        inp: new LastValue<string>(),
        d: new DeltaChannel<string[], string[]>(extend, { snapshotFrequency: 1 }),
        x: new LastValue<string>(),
        out: new LastValue<string>(),
      },
      inputChannels: ["inp"],
      outputChannels: ["out"],
      checkpointer: new MemorySaver(),
    });

  it("updateState after an exit snapshot infers the last writer", async () => {
    const graph = chainAfterADeltaChannel();
    await graph.invoke({ inp: "go" }, { ...config, durability: "exit" });

    await graph.updateState(config, "u");

    const { values } = await graph.getState(config);
    expect(values.out, "the update should apply as c, the last node to write").toBe(
      "u"
    );
  });

  it("updateState after a fork seal infers the subscriber that ran", async () => {
    const graph = new Pregel({
      nodes: {
        a: Channel.subscribeTo("inp")
          .pipe(() => ["a"])
          .pipe(Channel.writeTo(["d"], { go: "go" })),
        c: Channel.subscribeTo("go")
          .pipe(() => ["c"])
          .pipe(Channel.writeTo(["d"])),
        b: Channel.subscribeTo("d")
          .pipe(() => "b")
          .pipe(Channel.writeTo(["out"])),
      },
      channels: {
        inp: new LastValue<string>(),
        go: new EphemeralValue<string>(),
        d: new DeltaChannel<string[], string[]>(extend),
        out: new LastValue<string>(),
      },
      inputChannels: ["inp"],
      outputChannels: ["out"],
      checkpointer: new MemorySaver(),
    });
    await graph.invoke({ inp: "go" }, config);
    const base = await newest(graph, config, (s) => s.metadata?.step === 0);
    await graph.invoke(null, await graph.updateState(base.config, "u", "b"));

    await graph.updateState(config, "w");

    const { values } = await graph.getState(config);
    expect(values.out, "the update should apply as b, the last node to run").toBe(
      "w"
    );
  });

  it("updateState after a fork seal infers the node whose read it advanced", async () => {
    const graph = new Pregel({
      nodes: {
        a: Channel.subscribeTo("inp")
          .pipe(() => ["a"])
          .pipe(Channel.writeTo(["d"])),
        b: Channel.subscribeTo("d")
          .pipe(() => "b")
          .pipe(Channel.writeTo(["out"])),
      },
      channels: {
        inp: new LastValue<string>(),
        d: new DeltaChannel<string[], string[]>(extend),
        out: new LastValue<string>(),
      },
      inputChannels: ["inp"],
      outputChannels: ["out"],
      checkpointer: new MemorySaver(),
    });
    await graph.invoke({ inp: "1" }, config);
    await graph.invoke({ inp: "2" }, config);
    const base = await newest(
      graph,
      config,
      (s) => JSON.stringify(s.next) === JSON.stringify(["a"])
    );
    const fork = await graph.updateState(base.config, "u", "b");

    await graph.updateState(fork, "w");

    const { values } = await graph.getState(config);
    expect(values.out, "the update should apply as b, the last node to read").toBe(
      "w"
    );
  });

  it("updateState after a snapshotting update infers the last writer", async () => {
    const graph = chainAfterADeltaChannel();
    await graph.updateState(config, ["u"], "a");
    await graph.invoke(null, { ...config, interruptAfter: ["b"] });

    await graph.updateState(config, "u");

    const { values } = await graph.getState(config);
    expect(values.x, "the update should apply as b, the last node to write").toBe(
      "u"
    );
  });

  it("updateState on a thread seeded by updates applies as input", async () => {
    const graph = new StateGraph(
      Annotation.Root({
        x: Annotation<string[]>({ reducer: concat, default: () => [] }),
      })
    )
      .addNode("a", () => ({ x: ["a"] }))
      .addNode("b", () => ({ x: ["b"] }))
      .addEdge(START, "a")
      .addEdge("a", "b")
      .compile({ checkpointer: new MemorySaver() });
    await graph.updateState(config, { x: ["u1"] });

    await graph.updateState(config, { x: ["u2"] });

    const state = await graph.getState(config);
    expect({ x: state.values.x, next: state.next }).toEqual({
      x: ["u1", "u2"],
      next: ["a"],
    });
  });
});
