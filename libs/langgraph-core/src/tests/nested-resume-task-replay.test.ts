/**
 * Exercises task-result replay across a resume. A `task()` completed before an
 * `interrupt()` records its result as a pending write, so resuming the thread
 * must reuse that result rather than run the task body again — `task()` is the
 * wrapper for the non-idempotent step, so a second execution is a duplicated
 * side effect. The nested case is the regression: a subgraph loop receives
 * `checkpoint_id` as a key in its `configurable`, which made it read as a
 * time-travel replay and skipped applying the recorded writes.
 */

import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { describe, expect, it } from "vitest";

import { Annotation, StateGraph } from "../graph/index.js";
import { Command, END, START } from "../constants.js";
import { task } from "../func/index.js";
import { interrupt } from "../interrupt.js";
import { gatherIterator } from "../utils.js";

const State = Annotation.Root({
  result: Annotation<string>({
    reducer: (_a: string, b: string) => b,
    default: () => "",
  }),
});

/**
 * A graph whose single node completes a task, then interrupts. `counter` is
 * incremented by the task body, so it counts executions rather than calls.
 */
function buildGraph(counter: { runs: number }) {
  const node = async () => {
    const value = await task("countedTask", async () => {
      counter.runs += 1;
      return "value";
    })();
    const answer = interrupt("pause");
    return { result: `${value} ${answer}` };
  };
  return new StateGraph(State)
    .addNode("node", node)
    .addEdge(START, "node")
    .addEdge("node", END);
}

describe("task result replay on resume", () => {
  it("reuses a completed task result when the graph runs standalone", async () => {
    const counter = { runs: 0 };
    const graph = buildGraph(counter).compile({
      checkpointer: new MemorySaver(),
    });
    const config = { configurable: { thread_id: "standalone" } };

    await graph.invoke({}, config);
    expect(counter.runs).toBe(1);

    const result = await graph.invoke(new Command({ resume: "answer" }), config);
    expect(counter.runs).toBe(1);
    expect(result.result).toBe("value answer");
  });

  it("reuses a completed task result when the graph runs as a subgraph", async () => {
    const counter = { runs: 0 };
    const parent = new StateGraph(State)
      .addNode("child", buildGraph(counter).compile())
      .addEdge(START, "child")
      .addEdge("child", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "subgraph" } };

    await parent.invoke({}, config);
    expect(counter.runs).toBe(1);

    const result = await parent.invoke(
      new Command({ resume: "answer" }),
      config
    );
    expect(counter.runs).toBe(1);
    expect(result.result).toBe("value answer");
  });

  it("re-runs a completed task when replaying an explicit checkpoint", async () => {
    const counter = { runs: 0 };
    const parent = new StateGraph(State)
      .addNode("child", buildGraph(counter).compile())
      .addEdge(START, "child")
      .addEdge("child", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "time-travel" } };

    await parent.invoke({}, config);
    await parent.invoke(new Command({ resume: "answer" }), config);
    expect(counter.runs).toBe(1);

    const history = await gatherIterator(parent.getStateHistory(config));
    const first = history[history.length - 1];
    await parent.invoke(
      {},
      {
        configurable: {
          thread_id: "time-travel",
          checkpoint_id: first.config.configurable?.checkpoint_id,
        },
      }
    );
    expect(counter.runs).toBe(2);
  });
});
