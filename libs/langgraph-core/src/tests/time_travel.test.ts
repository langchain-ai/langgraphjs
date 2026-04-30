/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-param-reassign */
import { describe, it, expect, beforeAll } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { Command, START, INTERRUPT } from "../constants.js";
import { interrupt } from "../interrupt.js";
import { initializeAsyncLocalStorageSingleton } from "../setup/async_local_storage.js";
import { StateGraph } from "../graph/state.js";
import { Annotation } from "../graph/annotation.js";
import { gatherIterator } from "../utils.js";
import type { StateSnapshot } from "../pregel/types.js";

const State = Annotation.Root({
  value: Annotation<string[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
});

function checkpointSummary(history: any[]) {
  return history.map((s: any) => {
    const cid = s.config?.configurable?.checkpoint_id ?? "";
    const pid = s.parentConfig?.configurable?.checkpoint_id ?? null;
    return {
      id: cid.slice(-6),
      parentId: pid ? pid.slice(-6) : null,
      source: s.metadata?.source,
      next: s.next,
      values: s.values,
    };
  });
}

async function getSubgraphState(
  graph: any,
  config: any,
  subgraphName: string
): Promise<StateSnapshot> {
  return graph.getState(
    {
      configurable: {
        thread_id: config.configurable.thread_id,
        checkpoint_ns: subgraphName,
      },
    },
    { subgraphs: true }
  );
}

describe("Time Travel Tests", () => {
  beforeAll(() => {
    initializeAsyncLocalStorageSingleton();
  });

  // =========================================================================
  // PR #7038: Replay behavior for parent + subgraphs
  // =========================================================================

  describe("PR #7038: Replay behavior for parent + subgraphs", () => {
    it("should replay from checkpoint before interrupt and strip stale RESUME writes", async () => {
      const called: string[] = [];

      const nodeA = (_state: typeof State.State) => {
        called.push("node_a");
        return { value: ["a"] };
      };

      const askHuman = (_state: typeof State.State) => {
        called.push("ask_human");
        const answer = interrupt("What is your input?");
        return { value: [`human:${answer}`] };
      };

      const nodeB = (_state: typeof State.State) => {
        called.push("node_b");
        return { value: ["b"] };
      };

      const graph = new StateGraph(State)
        .addNode("node_a", nodeA)
        .addNode("ask_human", askHuman)
        .addNode("node_b", nodeB)
        .addEdge(START, "node_a")
        .addEdge("node_a", "ask_human")
        .addEdge("ask_human", "node_b")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "1" } };

      let result = await graph.invoke({ value: [] }, config);
      expect(result[INTERRUPT][0].value).toBe("What is your input?");

      result = await graph.invoke(
        new Command({ resume: "old_answer" }),
        config
      );
      expect(result.value).toEqual(["a", "human:old_answer", "b"]);

      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeAsk = history.find(
        (s: any) => s.next && s.next.includes("ask_human")
      );
      expect(beforeAsk).toBeDefined();

      called.length = 0;
      const replayResult = await graph.invoke(null, beforeAsk!.config);
      expect(replayResult[INTERRUPT][0].value).toBe("What is your input?");
      expect(called).toContain("ask_human");
      expect(called).not.toContain("node_a");
    });

    it("should replay with subgraph and strip stale RESUME writes", async () => {
      const called: string[] = [];

      const stepA = (_state: typeof State.State) => {
        called.push("step_a");
        return { value: ["step_a_done"] };
      };

      const ask1 = (_state: typeof State.State) => {
        called.push("ask_1");
        const answer = interrupt("Question 1?");
        return { value: [`ask_1:${answer}`] };
      };

      const ask2 = (_state: typeof State.State) => {
        called.push("ask_2");
        const answer = interrupt("Question 2?");
        return { value: [`ask_2:${answer}`] };
      };

      const executor = new StateGraph(State)
        .addNode("step_a", stepA)
        .addNode("ask_1", ask1)
        .addNode("ask_2", ask2)
        .addEdge(START, "step_a")
        .addEdge("step_a", "ask_1")
        .addEdge("ask_1", "ask_2")
        .addEdge("ask_2", "__end__")
        .compile({ checkpointer: true });

      const graph = new StateGraph(State)
        .addNode("executor", executor)
        .addEdge(START, "executor")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "1" } };

      let result = await graph.invoke({ value: [] }, config);
      expect(result[INTERRUPT][0].value).toBe("Question 1?");

      result = await graph.invoke(
        new Command({ resume: "answer_1" }),
        config
      );
      expect(result[INTERRUPT][0].value).toBe("Question 2?");

      result = await graph.invoke(
        new Command({ resume: "answer_2" }),
        config
      );
      expect(result[INTERRUPT]).toBeUndefined();

      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeExecutor = history.find(
        (s: any) => s.next && s.next.includes("executor")
      );
      expect(beforeExecutor).toBeDefined();

      called.length = 0;
      const replayResult = await graph.invoke(null, beforeExecutor!.config);
      expect(replayResult[INTERRUPT][0].value).toBe("Question 1?");
      expect(called).toContain("step_a");
      expect(called).toContain("ask_1");
      expect(called).not.toContain("ask_2");
    });
  });

  // =========================================================================
  // PR #7115: Replay bug, direct to subgraphs
  // =========================================================================

  describe("PR #7115: Direct-to-subgraph time travel", () => {
    it("should time travel to subgraph checkpoint at first interrupt", async () => {
      const called: string[] = [];

      const stepA = (_state: typeof State.State) => {
        called.push("step_a");
        return { value: ["step_a_done"] };
      };

      const ask1 = (_state: typeof State.State) => {
        called.push("ask_1");
        const answer = interrupt("Question 1?");
        return { value: [`ask_1:${answer}`] };
      };

      const ask2 = (_state: typeof State.State) => {
        called.push("ask_2");
        const answer = interrupt("Question 2?");
        return { value: [`ask_2:${answer}`] };
      };

      const executor = new StateGraph(State)
        .addNode("step_a", stepA)
        .addNode("ask_1", ask1)
        .addNode("ask_2", ask2)
        .addEdge(START, "step_a")
        .addEdge("step_a", "ask_1")
        .addEdge("ask_1", "ask_2")
        .addEdge("ask_2", "__end__")
        .compile({ checkpointer: true });

      const graph = new StateGraph(State)
        .addNode("executor", executor)
        .addEdge(START, "executor")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "1" } };

      await graph.invoke({ value: [] }, config);
      const subState = await getSubgraphState(graph, config, "executor");
      const subConfigAtFirst = subState.config;

      await graph.invoke(new Command({ resume: "answer_1" }), config);
      await graph.invoke(new Command({ resume: "answer_2" }), config);

      // Replay from subgraph checkpoint at 1st interrupt
      called.length = 0;
      const replayResult = await graph.invoke(null, subConfigAtFirst);
      expect(replayResult[INTERRUPT][0].value).toBe("Question 1?");
      expect(called).not.toContain("step_a");
      expect(called).toContain("ask_1");

      // Fork from subgraph checkpoint at 1st interrupt
      called.length = 0;
      const forkConfig = await graph.updateState(subConfigAtFirst, {
        value: ["forked"],
      });
      const forkResult = await graph.invoke(null, forkConfig);
      expect(forkResult[INTERRUPT][0].value).toBe("Question 1?");
      expect(called).not.toContain("step_a");
      expect(called).toContain("ask_1");
    });

    it("should time travel to subgraph checkpoint at second interrupt", async () => {
      const called: string[] = [];

      const stepA = (_state: typeof State.State) => {
        called.push("step_a");
        return { value: ["step_a_done"] };
      };

      const ask1 = (_state: typeof State.State) => {
        called.push("ask_1");
        const answer = interrupt("Question 1?");
        return { value: [`ask_1:${answer}`] };
      };

      const ask2 = (_state: typeof State.State) => {
        called.push("ask_2");
        const answer = interrupt("Question 2?");
        return { value: [`ask_2:${answer}`] };
      };

      const executor = new StateGraph(State)
        .addNode("step_a", stepA)
        .addNode("ask_1", ask1)
        .addNode("ask_2", ask2)
        .addEdge(START, "step_a")
        .addEdge("step_a", "ask_1")
        .addEdge("ask_1", "ask_2")
        .addEdge("ask_2", "__end__")
        .compile({ checkpointer: true });

      const graph = new StateGraph(State)
        .addNode("executor", executor)
        .addEdge(START, "executor")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "1" } };

      await graph.invoke({ value: [] }, config);
      await graph.invoke(new Command({ resume: "answer_1" }), config);

      const subState = await getSubgraphState(graph, config, "executor");
      const subConfig = subState.config;

      await graph.invoke(new Command({ resume: "answer_2" }), config);

      // Replay from subgraph checkpoint at 2nd interrupt
      called.length = 0;
      const replayResult = await graph.invoke(null, subConfig);
      expect(replayResult[INTERRUPT][0].value).toBe("Question 2?");
      expect(called).not.toContain("step_a");
      expect(called).not.toContain("ask_1");

      // Fork from subgraph checkpoint at 2nd interrupt
      called.length = 0;
      const forkConfig = await graph.updateState(subConfig, {
        value: ["forked"],
      });
      const forkResult = await graph.invoke(null, forkConfig);
      expect(forkResult[INTERRUPT][0].value).toBe("Question 2?");
      expect(called).not.toContain("step_a");
      expect(called).not.toContain("ask_1");
    });

    it("should time travel to subgraph checkpoint after completion", async () => {
      const called: string[] = [];

      const stepA = (_state: typeof State.State) => {
        called.push("step_a");
        return { value: ["step_a_done"] };
      };

      const ask1 = (_state: typeof State.State) => {
        called.push("ask_1");
        const answer = interrupt("Question 1?");
        return { value: [`ask_1:${answer}`] };
      };

      const ask2 = (_state: typeof State.State) => {
        called.push("ask_2");
        const answer = interrupt("Question 2?");
        return { value: [`ask_2:${answer}`] };
      };

      const executor = new StateGraph(State)
        .addNode("step_a", stepA)
        .addNode("ask_1", ask1)
        .addNode("ask_2", ask2)
        .addEdge(START, "step_a")
        .addEdge("step_a", "ask_1")
        .addEdge("ask_1", "ask_2")
        .addEdge("ask_2", "__end__")
        .compile({ checkpointer: true });

      const graph = new StateGraph(State)
        .addNode("executor", executor)
        .addEdge(START, "executor")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "1" } };

      await graph.invoke({ value: [] }, config);
      await graph.invoke(new Command({ resume: "answer_1" }), config);
      await graph.invoke(new Command({ resume: "answer_2" }), config);

      const finalState = await graph.getState(config);
      expect(finalState.tasks.length).toBe(0);

      called.length = 0;
      const replayResult = await graph.invoke(null, finalState.config);
      expect(replayResult[INTERRUPT]).toBeUndefined();
      expect(called).not.toContain("step_a");
      expect(called).not.toContain("ask_1");
      expect(called).not.toContain("ask_2");
      expect(replayResult.value).toContain("step_a_done");
      expect(replayResult.value).toContain("ask_1:answer_1");
      expect(replayResult.value).toContain("ask_2:answer_2");
    });

    it("should time travel to middle subgraph in 3-level graph", async () => {
      const called: string[] = [];

      const stepA = (_state: typeof State.State) => {
        called.push("step_a");
        return { value: ["step_a_done"] };
      };

      const ask1 = (_state: typeof State.State) => {
        called.push("ask_1");
        const answer = interrupt("Question 1?");
        return { value: [`ask_1:${answer}`] };
      };

      const ask2 = (_state: typeof State.State) => {
        called.push("ask_2");
        const answer = interrupt("Question 2?");
        return { value: [`ask_2:${answer}`] };
      };

      const inner = new StateGraph(State)
        .addNode("step_a", stepA)
        .addNode("ask_1", ask1)
        .addNode("ask_2", ask2)
        .addEdge(START, "step_a")
        .addEdge("step_a", "ask_1")
        .addEdge("ask_1", "ask_2")
        .addEdge("ask_2", "__end__")
        .compile({ checkpointer: true });

      const middle = new StateGraph(State)
        .addNode("inner", inner)
        .addEdge(START, "inner")
        .compile({ checkpointer: true });

      const graph = new StateGraph(State)
        .addNode("outer", middle)
        .addEdge(START, "outer")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "1" } };

      await graph.invoke({ value: [] }, config);
      await graph.invoke(new Command({ resume: "answer_1" }), config);

      const midState = await getSubgraphState(graph, config, "outer");
      const midConfig = midState.config;

      await graph.invoke(new Command({ resume: "answer_2" }), config);

      called.length = 0;
      const replayResult = await graph.invoke(null, midConfig);
      expect(replayResult[INTERRUPT]).toBeDefined();

      called.length = 0;
      const forkConfig = await graph.updateState(midConfig, {
        value: ["forked"],
      });
      const forkResult = await graph.invoke(null, forkConfig);
      expect(forkResult[INTERRUPT]).toBeDefined();
    });

    it("should time travel when middle subgraph has interrupts", async () => {
      const called: string[] = [];

      const pre = (_state: typeof State.State) => {
        called.push("pre");
        const answer = interrupt("Pre-question?");
        return { value: [`pre:${answer}`] };
      };

      const stepA = (_state: typeof State.State) => {
        called.push("step_a");
        return { value: ["step_a_done"] };
      };

      const ask1 = (_state: typeof State.State) => {
        called.push("ask_1");
        const answer = interrupt("Question 1?");
        return { value: [`ask_1:${answer}`] };
      };

      const inner = new StateGraph(State)
        .addNode("step_a", stepA)
        .addNode("ask_1", ask1)
        .addEdge(START, "step_a")
        .addEdge("step_a", "ask_1")
        .addEdge("ask_1", "__end__")
        .compile({ checkpointer: true });

      const middle = new StateGraph(State)
        .addNode("pre", pre)
        .addNode("inner", inner)
        .addEdge(START, "pre")
        .addEdge("pre", "inner")
        .addEdge("inner", "__end__")
        .compile({ checkpointer: true });

      const graph = new StateGraph(State)
        .addNode("outer", middle)
        .addEdge(START, "outer")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "1" } };

      let result = await graph.invoke({ value: [] }, config);
      expect(result[INTERRUPT][0].value).toBe("Pre-question?");

      const midStateAtPre = await getSubgraphState(graph, config, "outer");
      const midConfigAtPre = midStateAtPre.config;

      result = await graph.invoke(
        new Command({ resume: "pre_answer" }),
        config
      );
      expect(result[INTERRUPT][0].value).toBe("Question 1?");

      const midStateAtAsk1 = await getSubgraphState(graph, config, "outer");
      const midConfigAtAsk1 = midStateAtAsk1.config;

      result = await graph.invoke(new Command({ resume: "answer_1" }), config);
      expect(result[INTERRUPT]).toBeUndefined();

      called.length = 0;
      const replayPre = await graph.invoke(null, midConfigAtPre);
      expect(replayPre[INTERRUPT][0].value).toBe("Pre-question?");
      expect(called).toContain("pre");
      expect(called).not.toContain("step_a");
      expect(called).not.toContain("ask_1");

      called.length = 0;
      const forkPreConfig = await graph.updateState(midConfigAtPre, {
        value: ["forked"],
      });
      const forkPreResult = await graph.invoke(null, forkPreConfig);
      expect(forkPreResult[INTERRUPT][0].value).toBe("Pre-question?");
      expect(called).toContain("pre");
      expect(called).not.toContain("step_a");

      called.length = 0;
      const replayAsk1 = await graph.invoke(null, midConfigAtAsk1);
      expect(replayAsk1[INTERRUPT][0].value).toBe("Question 1?");
      expect(called).not.toContain("pre");
      expect(called).toContain("ask_1");

      called.length = 0;
      const forkAsk1Config = await graph.updateState(midConfigAtAsk1, {
        value: ["forked"],
      });
      const forkAsk1Result = await graph.invoke(null, forkAsk1Config);
      expect(forkAsk1Result[INTERRUPT][0].value).toBe("Question 1?");
      expect(called).not.toContain("pre");
      expect(called).toContain("ask_1");
    });
  });

  // =========================================================================
  // PR #7498: Time travel when going back to interrupt node
  // =========================================================================

  describe("PR #7498: Eager fork checkpoint on time travel", () => {
    it("should create fork checkpoint on replay from before interrupt then resume", async () => {
      const called: string[] = [];

      const nodeA = (_state: typeof State.State) => {
        called.push("node_a");
        return { value: ["a"] };
      };

      const askHuman = (_state: typeof State.State) => {
        called.push("ask_human");
        const answer = interrupt("What is your input?");
        return { value: [`human:${answer}`] };
      };

      const nodeB = (_state: typeof State.State) => {
        called.push("node_b");
        return { value: ["b"] };
      };

      const graph = new StateGraph(State)
        .addNode("node_a", nodeA)
        .addNode("ask_human", askHuman)
        .addNode("node_b", nodeB)
        .addEdge(START, "node_a")
        .addEdge("node_a", "ask_human")
        .addEdge("ask_human", "node_b")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "1" } };

      await graph.invoke({ value: [] }, config);
      await graph.invoke(new Command({ resume: "old_answer" }), config);

      const originalHistory = await gatherIterator(
        graph.getStateHistory(config)
      );
      const original = checkpointSummary(originalHistory);
      expect(original.map((s: any) => [s.source, s.next, s.values])).toEqual([
        ["loop", [], { value: ["a", "human:old_answer", "b"] }],
        ["loop", ["node_b"], { value: ["a", "human:old_answer"] }],
        ["loop", ["ask_human"], { value: ["a"] }],
        ["loop", ["node_a"], { value: [] }],
        ["input", ["__start__"], { value: [] }],
      ]);

      const beforeAsk = originalHistory.find(
        (s: any) => s.next && s.next.includes("ask_human")
      );

      called.length = 0;
      const replayResult = await graph.invoke(null, beforeAsk!.config);
      expect(replayResult[INTERRUPT][0].value).toBe("What is your input?");
      expect(called).toContain("ask_human");
      expect(called).not.toContain("node_a");

      const postReplay = checkpointSummary(
        await gatherIterator(graph.getStateHistory(config))
      );
      expect(postReplay.map((s: any) => [s.source, s.next])).toEqual([
        ["fork", ["ask_human"]],
        ["loop", []],
        ["loop", ["node_b"]],
        ["loop", ["ask_human"]],
        ["loop", ["node_a"]],
        ["input", ["__start__"]],
      ]);

      called.length = 0;
      const finalResult = await graph.invoke(
        new Command({ resume: "new_answer" }),
        config
      );
      expect(finalResult.value).toEqual(["a", "human:new_answer", "b"]);
      expect(called).toContain("ask_human");
      expect(called).toContain("node_b");

      const final = checkpointSummary(
        await gatherIterator(graph.getStateHistory(config))
      );
      expect(final.map((s: any) => [s.source, s.next, s.values])).toEqual([
        ["loop", [], { value: ["a", "human:new_answer", "b"] }],
        ["loop", ["node_b"], { value: ["a", "human:new_answer"] }],
        ["fork", ["ask_human"], { value: ["a"] }],
        ["loop", [], { value: ["a", "human:old_answer", "b"] }],
        ["loop", ["node_b"], { value: ["a", "human:old_answer"] }],
        ["loop", ["ask_human"], { value: ["a"] }],
        ["loop", ["node_a"], { value: [] }],
        ["input", ["__start__"], { value: [] }],
      ]);
    });

    it("should create fork on subgraph time travel and resume from first interrupt", async () => {
      const called: string[] = [];

      const stepA = (_state: typeof State.State) => {
        called.push("step_a");
        return { value: ["step_a_done"] };
      };

      const ask1 = (_state: typeof State.State) => {
        called.push("ask_1");
        const answer = interrupt("Question 1?");
        return { value: [`ask_1:${answer}`] };
      };

      const ask2 = (_state: typeof State.State) => {
        called.push("ask_2");
        const answer = interrupt("Question 2?");
        return { value: [`ask_2:${answer}`] };
      };

      const executor = new StateGraph(State)
        .addNode("step_a", stepA)
        .addNode("ask_1", ask1)
        .addNode("ask_2", ask2)
        .addEdge(START, "step_a")
        .addEdge("step_a", "ask_1")
        .addEdge("ask_1", "ask_2")
        .addEdge("ask_2", "__end__")
        .compile({ checkpointer: true });

      const graph = new StateGraph(State)
        .addNode("executor", executor)
        .addEdge(START, "executor")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "1" } };

      await graph.invoke({ value: [] }, config);
      const subConfigAtFirst = (
        await getSubgraphState(graph, config, "executor")
      ).config;
      await graph.invoke(new Command({ resume: "answer_1" }), config);
      await graph.invoke(new Command({ resume: "answer_2" }), config);

      const original = checkpointSummary(
        await gatherIterator(graph.getStateHistory(config))
      );
      expect(original.map((s: any) => [s.source, s.next, s.values])).toEqual([
        [
          "loop",
          [],
          { value: ["step_a_done", "ask_1:answer_1", "ask_2:answer_2"] },
        ],
        ["loop", ["executor"], { value: [] }],
        ["input", ["__start__"], { value: [] }],
      ]);

      called.length = 0;
      const replayResult = await graph.invoke(null, subConfigAtFirst);
      expect(replayResult[INTERRUPT][0].value).toBe("Question 1?");
      expect(called).not.toContain("step_a");

      const postTt = checkpointSummary(
        await gatherIterator(graph.getStateHistory(config))
      );
      expect(postTt.map((s: any) => [s.source, s.next])).toEqual([
        ["fork", ["executor"]],
        ["loop", []],
        ["loop", ["executor"]],
        ["input", ["__start__"]],
      ]);

      called.length = 0;
      const resume1 = await graph.invoke(
        new Command({ resume: "new_answer_1" }),
        config
      );
      expect(resume1[INTERRUPT][0].value).toBe("Question 2?");
      expect(called).toContain("ask_1");

      called.length = 0;
      const resume2 = await graph.invoke(
        new Command({ resume: "new_answer_2" }),
        config
      );
      expect(resume2.value).toEqual([
        "step_a_done",
        "ask_1:new_answer_1",
        "ask_2:new_answer_2",
      ]);

      const final = checkpointSummary(
        await gatherIterator(graph.getStateHistory(config))
      );
      expect(final.map((s: any) => [s.source, s.next, s.values])).toEqual([
        [
          "loop",
          [],
          {
            value: [
              "step_a_done",
              "ask_1:new_answer_1",
              "ask_2:new_answer_2",
            ],
          },
        ],
        ["fork", ["executor"], { value: [] }],
        [
          "loop",
          [],
          { value: ["step_a_done", "ask_1:answer_1", "ask_2:answer_2"] },
        ],
        ["loop", ["executor"], { value: [] }],
        ["input", ["__start__"], { value: [] }],
      ]);
    });

    it("should create fork on subgraph time travel and resume from second interrupt", async () => {
      const called: string[] = [];

      const stepA = (_state: typeof State.State) => {
        called.push("step_a");
        return { value: ["step_a_done"] };
      };

      const ask1 = (_state: typeof State.State) => {
        called.push("ask_1");
        const answer = interrupt("Question 1?");
        return { value: [`ask_1:${answer}`] };
      };

      const ask2 = (_state: typeof State.State) => {
        called.push("ask_2");
        const answer = interrupt("Question 2?");
        return { value: [`ask_2:${answer}`] };
      };

      const executor = new StateGraph(State)
        .addNode("step_a", stepA)
        .addNode("ask_1", ask1)
        .addNode("ask_2", ask2)
        .addEdge(START, "step_a")
        .addEdge("step_a", "ask_1")
        .addEdge("ask_1", "ask_2")
        .addEdge("ask_2", "__end__")
        .compile({ checkpointer: true });

      const graph = new StateGraph(State)
        .addNode("executor", executor)
        .addEdge(START, "executor")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "1" } };

      await graph.invoke({ value: [] }, config);
      await graph.invoke(new Command({ resume: "answer_1" }), config);
      const subConfigAtSecond = (
        await getSubgraphState(graph, config, "executor")
      ).config;
      await graph.invoke(new Command({ resume: "answer_2" }), config);

      called.length = 0;
      const replayResult = await graph.invoke(null, subConfigAtSecond);
      expect(replayResult[INTERRUPT][0].value).toBe("Question 2?");
      expect(called).not.toContain("step_a");
      expect(called).not.toContain("ask_1");

      const postTt = checkpointSummary(
        await gatherIterator(graph.getStateHistory(config))
      );
      expect(postTt.map((s: any) => [s.source, s.next])).toEqual([
        ["fork", ["executor"]],
        ["loop", []],
        ["loop", ["executor"]],
        ["input", ["__start__"]],
      ]);

      called.length = 0;
      const resumeResult = await graph.invoke(
        new Command({ resume: "new_answer_2" }),
        config
      );
      expect(resumeResult.value).toEqual([
        "step_a_done",
        "ask_1:answer_1",
        "ask_2:new_answer_2",
      ]);

      const final = checkpointSummary(
        await gatherIterator(graph.getStateHistory(config))
      );
      expect(final.map((s: any) => [s.source, s.next, s.values])).toEqual([
        [
          "loop",
          [],
          {
            value: [
              "step_a_done",
              "ask_1:answer_1",
              "ask_2:new_answer_2",
            ],
          },
        ],
        ["fork", ["executor"], { value: [] }],
        [
          "loop",
          [],
          { value: ["step_a_done", "ask_1:answer_1", "ask_2:answer_2"] },
        ],
        ["loop", ["executor"], { value: [] }],
        ["input", ["__start__"], { value: [] }],
      ]);
    });

    it("should verify checkpoint pattern on subgraph time travel", async () => {
      const ask = (_state: typeof State.State) => {
        const answer = interrupt("Q?");
        return { value: [`a:${answer}`] };
      };

      const executor = new StateGraph(State)
        .addNode("ask", ask)
        .addEdge(START, "ask")
        .compile({ checkpointer: true });

      const graph = new StateGraph(State)
        .addNode("executor", executor)
        .addEdge(START, "executor")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "1" } };

      await graph.invoke({ value: [] }, config);
      const subConfig = (await getSubgraphState(graph, config, "executor"))
        .config;
      await graph.invoke(new Command({ resume: "first" }), config);

      const original = checkpointSummary(
        await gatherIterator(graph.getStateHistory(config))
      );
      expect(original.map((s: any) => [s.source, s.next, s.values])).toEqual([
        ["loop", [], { value: ["a:first"] }],
        ["loop", ["executor"], { value: [] }],
        ["input", ["__start__"], { value: [] }],
      ]);

      await graph.invoke(null, subConfig);

      const postTt = await gatherIterator(graph.getStateHistory(config));
      const postTtSummary = checkpointSummary(postTt);
      expect(postTtSummary.map((s: any) => [s.source, s.next])).toEqual([
        ["fork", ["executor"]],
        ["loop", []],
        ["loop", ["executor"]],
        ["input", ["__start__"]],
      ]);

      const replayPointId =
        subConfig.configurable?.checkpoint_map?.[""];
      expect(
        postTt[0].parentConfig?.configurable?.checkpoint_id
      ).toBe(replayPointId);

      const result = await graph.invoke(
        new Command({ resume: "second" }),
        config
      );
      expect(result.value).toEqual(["a:second"]);

      const final = checkpointSummary(
        await gatherIterator(graph.getStateHistory(config))
      );
      expect(final.map((s: any) => [s.source, s.next, s.values])).toEqual([
        ["loop", [], { value: ["a:second"] }],
        ["fork", ["executor"], { value: [] }],
        ["loop", [], { value: ["a:first"] }],
        ["loop", ["executor"], { value: [] }],
        ["input", ["__start__"], { value: [] }],
      ]);
    });

    it("should replay from parent checkpoint with subgraph interrupt then resume", async () => {
      const called: string[] = [];

      const router = (_state: typeof State.State) => {
        called.push("router");
        return { value: ["routed"] };
      };

      const stepA = (_state: typeof State.State) => {
        called.push("step_a");
        return { value: ["sub_a"] };
      };

      const askHuman = (_state: typeof State.State) => {
        called.push("ask_human");
        const answer = interrupt("Provide input:");
        return { value: [`human:${answer}`] };
      };

      const stepB = (_state: typeof State.State) => {
        called.push("step_b");
        return { value: ["sub_b"] };
      };

      const subgraph = new StateGraph(State)
        .addNode("step_a", stepA)
        .addNode("ask_human", askHuman)
        .addNode("step_b", stepB)
        .addEdge(START, "step_a")
        .addEdge("step_a", "ask_human")
        .addEdge("ask_human", "step_b")
        .compile({ checkpointer: true });

      const postProcess = (_state: typeof State.State) => {
        called.push("post_process");
        return { value: ["post"] };
      };

      const graph = new StateGraph(State)
        .addNode("router", router)
        .addNode("subgraph_node", subgraph)
        .addNode("post_process", postProcess)
        .addEdge(START, "router")
        .addEdge("router", "subgraph_node")
        .addEdge("subgraph_node", "post_process")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "1" } };

      await graph.invoke({ value: [] }, config);
      await graph.invoke(new Command({ resume: "old_answer" }), config);

      const originalHistory = await gatherIterator(
        graph.getStateHistory(config)
      );
      expect(originalHistory.map((s: any) => s.next)).toEqual([
        [],
        ["post_process"],
        ["subgraph_node"],
        ["router"],
        ["__start__"],
      ]);

      const interruptCheckpoint = originalHistory.find(
        (s: any) => s.next && s.next.includes("subgraph_node")
      );

      called.length = 0;
      const replayResult = await graph.invoke(
        null,
        interruptCheckpoint!.config
      );
      expect(replayResult[INTERRUPT]).toBeDefined();
      expect(replayResult[INTERRUPT][0].value).toBe("Provide input:");
      expect(called).toContain("step_a");
      expect(called).toContain("ask_human");
      expect(called).not.toContain("step_b");

      const postReplayHistory = await gatherIterator(
        graph.getStateHistory(config)
      );
      expect(postReplayHistory.map((s: any) => s.next)).toEqual([
        ["subgraph_node"],
        [],
        ["post_process"],
        ["subgraph_node"],
        ["router"],
        ["__start__"],
      ]);
      expect(
        postReplayHistory.map((s: any) => s.metadata?.source)
      ).toEqual(["fork", "loop", "loop", "loop", "loop", "input"]);

      called.length = 0;
      const finalResult = await graph.invoke(
        new Command({ resume: "new_answer" }),
        config
      );
      expect(finalResult[INTERRUPT]).toBeUndefined();
      expect(finalResult.value).toContain("human:new_answer");
      expect(finalResult.value).toContain("sub_b");
      expect(finalResult.value).toContain("post");
      expect(called).toContain("ask_human");
      expect(called).toContain("step_b");
      expect(called).toContain("post_process");

      const finalHistory = await gatherIterator(
        graph.getStateHistory(config)
      );
      expect(finalHistory.map((s: any) => s.next)).toEqual([
        [],
        ["post_process"],
        ["subgraph_node"],
        [],
        ["post_process"],
        ["subgraph_node"],
        ["router"],
        ["__start__"],
      ]);
      expect(finalHistory.map((s: any) => s.metadata?.source)).toEqual([
        "loop",
        "loop",
        "fork",
        "loop",
        "loop",
        "loop",
        "loop",
        "input",
      ]);
    });
  });
});
