import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { describe, expect, it, vi } from "vitest";

import { Annotation, StateGraph } from "../graph/index.js";
import { Command, END, START } from "../constants.js";
import { interrupt } from "../interrupt.js";
import type { LangGraphRunnableConfig } from "../pregel/runnable_types.js";

const State = Annotation.Root({
  log: Annotation<string[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
});

describe("resuming at the latest checkpoint", () => {
  it.each(["head", "undefined"] as const)(
    "doesn't rerun a node that already finished (checkpoint_id: %s)",
    async (checkpointId) => {
      const answered = { a: 0, b: 0 };
      const graph = new StateGraph(State)
        .addNode("a", () => {
          const answer = interrupt("A");
          answered.a += 1;
          return { log: [`a:${answer}`] };
        })
        .addNode("b", () => {
          const answer = interrupt("B");
          answered.b += 1;
          return { log: [`b:${answer}`] };
        })
        .addEdge(START, "a")
        .addEdge(START, "b")
        .compile({ checkpointer: new MemorySaver() });
      const config = { configurable: { thread_id: "1" } };
      await graph.invoke({ log: [] }, config);

      let log: string[] = [];
      for (const question of ["A", "B"]) {
        const snapshot = await graph.getState(config);
        const pending = snapshot.tasks
          .flatMap((task) => task.interrupts)
          .find((i) => i.value === question);
        const target =
          checkpointId === "head"
            ? snapshot.config
            : { configurable: { thread_id: "1", checkpoint_id: undefined } };
        const result = await graph.invoke(
          new Command({ resume: { [pending!.id!]: "yes" } }),
          target
        );
        log = result.log;
      }

      expect(answered).toEqual({ a: 1, b: 1 });
      expect([...log].sort()).toEqual(["a:yes", "b:yes"]);
    }
  );
});

describe("resuming routing after a parallel failure", () => {
  it.each(["conditional", "command", "static"] as const)(
    "preserves %s routing without rerunning a completed node",
    async (routing) => {
      const LoopState = Annotation.Root({
        x: Annotation<number>(),
        n: Annotation<number>(),
        other: Annotation<number>(),
      });
      const next = (n: number) => (n < 2 ? "body" : "done");
      const start = vi.fn(() =>
        routing === "command"
          ? new Command({ update: { n: 0 }, goto: next(0) })
          : { n: 0 }
      );
      let failures = 1;
      const builder = new StateGraph(LoopState)
        .addNode("fork", () => ({}))
        .addNode(
          "start",
          start,
          routing === "command" ? { ends: ["body", "done"] } : undefined
        )
        .addNode("body", (s) => ({ x: s.x + 1 }))
        .addNode(
          "tick",
          (s) =>
            routing === "command"
              ? new Command({ update: { n: s.n + 1 }, goto: next(s.n + 1) })
              : { n: s.n + 1 },
          routing === "command" ? { ends: ["body", "done"] } : undefined
        )
        .addNode("done", () => ({}))
        .addNode("flaky", () => {
          if (failures-- > 0) throw new Error("transient failure");
          return { other: 1 };
        })
        .addNode("join", () => ({}))
        .addEdge(START, "fork")
        .addEdge("fork", "start")
        .addEdge("fork", "flaky")
        .addEdge("body", "tick")
        .addEdge(["done", "flaky"], "join")
        .addEdge("join", END);
      if (routing === "conditional") {
        builder.addConditionalEdges("start", (s) => next(s.n), [
          "body",
          "done",
        ]);
      } else if (routing === "static") {
        builder.addEdge("start", "body");
      }
      if (routing !== "command") {
        builder.addConditionalEdges("tick", (s) => next(s.n), ["body", "done"]);
      }
      const graph = builder.compile({ checkpointer: new MemorySaver() });
      const config = { configurable: { thread_id: "routing" } };

      await expect(graph.invoke({ x: 1 }, config)).rejects.toThrow(
        "transient failure"
      );
      expect(await graph.invoke(null, config)).toEqual({
        x: 3,
        n: 2,
        other: 1,
      });
      expect(start).toHaveBeenCalledTimes(1);
    }
  );
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("finishing routing writes before checkpointing", () => {
  it("preserves a partial static join without replaying the side node", async () => {
    const JoinState = Annotation.Root({
      y: Annotation<number>(),
      other: Annotation<number>(),
      done: Annotation<string>(),
    });
    const release = gate();
    const side = vi.fn(async () => {
      await release.promise;
      return { y: 1 };
    });
    let failures = 1;
    const graph = new StateGraph(JoinState)
      .addNode("fork", () => ({}))
      .addNode("side", side)
      .addNode("flaky", async () => {
        release.resolve();
        await release.promise;
        if (failures-- > 0) throw new Error("transient failure");
        return { other: 1 };
      })
      .addNode("join", () => ({}))
      .addNode("after", () => ({ done: "ran" }))
      .addEdge(START, "fork")
      .addEdge("fork", "side")
      .addEdge("fork", "flaky")
      .addEdge(["side", "flaky"], "join")
      .addEdge("join", "after")
      .addEdge("after", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "join" } };

    await expect(graph.invoke({}, config)).rejects.toThrow("transient failure");
    expect(await graph.invoke(null, config)).toEqual({
      y: 1,
      other: 1,
      done: "ran",
    });
    expect(side).toHaveBeenCalledTimes(1);
  });

  it("waits for an async route before committing a successful sibling", async () => {
    const RouteState = Annotation.Root({
      updates: Annotation<number>({
        reducer: (a, b) => a + b,
        default: () => 0,
      }),
      other: Annotation<number>(),
      done: Annotation<boolean>(),
    });
    const routeStarted = gate();
    const releaseRoute = gate();
    const siblingCancelled = gate();
    let routeFinished = false;
    const side = vi.fn(
      (_: typeof RouteState.State, config: LangGraphRunnableConfig) => {
        config.signal!.addEventListener("abort", siblingCancelled.resolve, {
          once: true,
        });
        return { updates: 1 };
      }
    );
    let failures = 1;
    const checkpointer = new MemorySaver();
    const graph = new StateGraph(RouteState)
      .addNode("side", side)
      .addNode("flaky", async () => {
        await routeStarted.promise;
        if (failures-- > 0) throw new Error("transient failure");
        return { other: 1 };
      })
      .addNode("after", () => ({ done: true }))
      .addEdge(START, "side")
      .addEdge(START, "flaky")
      .addConditionalEdges(
        "side",
        async () => {
          routeStarted.resolve();
          await releaseRoute.promise;
          routeFinished = true;
          return "after";
        },
        ["after"]
      )
      .addEdge("after", END)
      .compile({ checkpointer });
    const config = { configurable: { thread_id: "async-route" } };
    const run = graph.invoke({}, config);
    // Attach the rejection handler immediately, before releasing either gate.
    const failed = expect(run).rejects.toThrow("transient failure");
    await siblingCancelled.promise;
    releaseRoute.resolve();
    await failed;
    expect(routeFinished).toBe(true);

    const checkpoint = await checkpointer.getTuple(config);
    expect(checkpoint?.pendingWrites).toEqual(
      expect.arrayContaining([
        [expect.any(String), "updates", 1],
        [expect.any(String), "branch:to:after", "side"],
      ])
    );
    expect(await graph.invoke(null, config)).toEqual({
      updates: 1,
      other: 1,
      done: true,
    });
    expect(side).toHaveBeenCalledTimes(1);
  });
});
