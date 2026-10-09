import { describe, expect, it } from "vitest";
import {
  BaseCheckpointSaver,
  MemorySaver,
  type CheckpointTuple,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Annotation } from "../graph/index.js";
import { StateGraph } from "../graph/state.js";
import { START } from "../constants.js";
import { Command } from "../constants.js";
import { DeltaChannel } from "../channels/delta.js";
import { interrupt } from "../interrupt.js";
/**
 * Port of langgraph #9114's exit-mode resume tests: a resumed exit-durability
 * run must replay its delta writes in live order — the resumed superstep's
 * writes interleave with the ones loaded from the checkpoint by task path,
 * later supersteps sort after every real write, and writes loaded with the
 * checkpoint are not stored again.
 */

const appendReducer = (current: string[], writes: string[][]): string[] => {
  const out = [...current];
  for (const w of writes) out.push(...w);
  return out;
};

const resumeState = () =>
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

function exitConfig(thread: string) {
  return {
    configurable: { thread_id: thread },
    durability: "exit" as const,
  };
}

describe("exit durability: resumed runs replay delta writes in live order", () => {
  it.each([false, true])(
    "resume after a parallel interrupt replays in live order (addressed: %s)",
    async (addressed) => {
      const State = resumeState();
      const graph = new StateGraph(State)
        .addNode("done", () => both("done"))
        .addNode("ask", ask("ask"))
        .addNode("after", () => both("after"))
        .addEdge(START, "done")
        .addEdge(START, "ask")
        .addEdge("ask", "after")
        .compile({ checkpointer: new MemorySaver() });
      const config = exitConfig("parallel-interrupt");
      await graph.invoke(both("in"), config);
      const head = (await graph.getState(config)).config;

      const resumeConfig = addressed ? head : config;
      await graph.invoke(
        new Command({ resume: "yes" }),
        { ...resumeConfig, durability: "exit" as const }
      );

      const state = await graph.getState(config);
      const log = (state.values as { log: string[] }).log;
      const plain = (state.values as { plain: string[] }).plain;
      // Before #9114's fix the loaded "done" write replayed twice and out of
      // order; the DeltaChannel must now agree with the plain channel.
      expect(log).toEqual(plain);
      expect([...log].sort()).toEqual(["after", "ask", "done", "in"]);
    }
  );

  it("a Command(resume, update) write replays once, in live order", async () => {
    const State = resumeState();
    const graph = new StateGraph(State)
      .addNode("done", () => both("done"))
      .addNode("ask", ask("ask"))
      .addEdge(START, "done")
      .addEdge(START, "ask")
      .compile({ checkpointer: new MemorySaver() });
    const config = exitConfig("command-update");
    await graph.invoke(both("in"), config);

    await graph.invoke(
      new Command({ resume: "yes", update: both("cmd") }),
      { ...config, durability: "exit" as const }
    );

    const state = await graph.getState(config);
    const log = (state.values as { log: string[] }).log;
    const plain = (state.values as { plain: string[] }).plain;
    expect(log).toEqual(plain);
    expect(log).toEqual(["in", "cmd", "ask", "done"]);
  });

  it("an addressed resume keeps a rerun task's write to a new channel", async () => {
    const State = Annotation.Root({
      log: new DeltaChannel<string[], string[]>(appendReducer),
      plain: Annotation<string[]>({
        reducer: (a, b) => [...a, ...b],
        default: () => [],
      }),
      extra: new DeltaChannel<string[], string[]>(appendReducer),
      flag: Annotation<boolean>({ reducer: (_, b) => b, default: () => false }),
    });
    const done = (state: { flag?: boolean }) => ({
      ...both("done"),
      ...(state.flag ? { extra: ["new"] } : {}),
    });
    const graph = new StateGraph(State)
      .addNode("done", done)
      .addNode("ask", ask("ask"))
      .addEdge(START, "done")
      .addEdge(START, "ask")
      .compile({ checkpointer: new MemorySaver() });
    const config = exitConfig("new-channel");
    await graph.invoke(both("in"), config);
    const head = (await graph.getState(config)).config;

    // The rerun `done` task already wrote `log` before the interrupt, so its
    // `log` write is skipped on replay — but its write to `extra`, a channel
    // it did not write before, must be kept.
    const live = await graph.invoke(
      new Command({ resume: "yes", update: { flag: true } }),
      { ...head, durability: "exit" as const }
    );

    const state = await graph.getState(config);
    expect((live as { extra?: string[] }).extra).toEqual(["new"]);
    expect((state.values as { extra?: string[] }).extra).toEqual(["new"]);
    const log = (state.values as { log: string[] }).log;
    const plain = (state.values as { plain: string[] }).plain;
    expect(log).toEqual(plain);
  });

  it("the resumed superstep interleaves with loaded writes by task path", async () => {
    // `a_asks` resumes after `z_done` finished; live order applies `a` first,
    // so the replay must too — not by task id, where `a` vs `z` is a coin
    // flip of the uuid5 hashes.
    const State = resumeState();
    const graph = new StateGraph(State)
      .addNode("z_done", () => both("z"))
      .addNode("a_asks", ask("a"))
      .addEdge(START, "z_done")
      .addEdge(START, "a_asks")
      .compile({ checkpointer: new MemorySaver() });
    const config = exitConfig("interleave");
    await graph.invoke(both("in"), config);

    await graph.invoke(
      new Command({ resume: "yes" }),
      { ...config, durability: "exit" as const }
    );

    const state = await graph.getState(config);
    const log = (state.values as { log: string[] }).log;
    const plain = (state.values as { plain: string[] }).plain;
    expect(log).toEqual(plain);
    expect(log).toEqual(["in", "a", "z"]);
  });
});

/** Replays each checkpoint's writes by task id, as path-less savers do. */
class TaskIdOrderSaver extends MemorySaver {
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const tup = await super.getTuple(config);
    if (tup?.pendingWrites?.length) {
      tup.pendingWrites = [...tup.pendingWrites].sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
      );
    }
    return tup;
  }

  // Force the base walk, which trusts getTuple order.
  override getDeltaChannelHistory(
    args: Parameters<BaseCheckpointSaver["getDeltaChannelHistory"]>[0]
  ) {
    return BaseCheckpointSaver.prototype.getDeltaChannelHistory.call(this, args);
  }
}

describe("exit durability: superstep order holds on a task-id-ordered saver", () => {
  it("an exit run replays its supersteps in order", async () => {
    const State = resumeState();
    const graph = new StateGraph(State)
      .addNode("a", () => both("a"))
      .addNode("b", () => both("b"))
      .addEdge(START, "a")
      .addEdge("a", "b")
      .compile({ checkpointer: new TaskIdOrderSaver() });
    const config = exitConfig("id-order-run");

    await graph.invoke(both("in"), config);

    const state = await graph.getState(config);
    expect((state.values as { log: string[] }).log).toEqual(["in", "a", "b"]);
  });

  it("an exit resume replays its supersteps in order", async () => {
    const State = resumeState();
    const graph = new StateGraph(State)
      .addNode("ask", ask("ask"))
      .addNode("after", () => both("after"))
      .addEdge(START, "ask")
      .addEdge("ask", "after")
      .compile({ checkpointer: new TaskIdOrderSaver() });
    const config = exitConfig("id-order-resume");
    await graph.invoke(both("in"), config);

    await graph.invoke(
      new Command({ resume: "yes" }),
      { ...config, durability: "exit" as const }
    );

    const state = await graph.getState(config);
    expect((state.values as { log: string[] }).log).toEqual([
      "in",
      "ask",
      "after",
    ]);
  });
});

class FailingPutSaver extends MemorySaver {
  fail = false;

  override async put(...args: Parameters<MemorySaver["put"]>) {
    if (this.fail) {
      throw new Error("final checkpoint lost");
    }
    return super.put(...args);
  }
}

describe("exit durability: a resume retried after its final checkpoint fails", () => {
  it("reruns the resumed task and does not lose its writes", async () => {
    const saver = new FailingPutSaver();
    const State = resumeState();
    const graph = new StateGraph(State)
      .addNode("done", () => both("done"))
      .addNode("ask", ask("ask"))
      .addEdge(START, "done")
      .addEdge(START, "ask")
      .compile({ checkpointer: saver });
    const config = exitConfig("fail-retry");
    await graph.invoke(both("in"), config);
    saver.fail = true;
    await expect(
      graph.invoke(new Command({ resume: "yes" }), {
        ...config,
        durability: "exit" as const,
      })
    ).rejects.toThrow(/final checkpoint lost/);
    saver.fail = false;

    await graph.invoke(
      new Command({ resume: "yes" }),
      { ...config, durability: "exit" as const }
    );

    const state = await graph.getState(config);
    const log = (state.values as { log: string[] }).log;
    const plain = (state.values as { plain: string[] }).plain;
    expect(log).toEqual(plain);
    expect([...plain].sort()).toEqual(["ask", "done", "in"]);
  });
});
