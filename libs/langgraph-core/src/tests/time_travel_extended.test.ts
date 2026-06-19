import { describe, it, expect, beforeAll } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { Command, COPY, END, START } from "../constants.js";
import type { LangGraphRunnableConfig } from "../pregel/runnable_types.js";
import { interrupt } from "../interrupt.js";
import { initializeAsyncLocalStorageSingleton } from "../node.js";
import { StateGraph } from "../graph/state.js";
import { Annotation } from "../graph/annotation.js";
import { gatherIterator } from "../utils.js";
import {
  TimeTravelState as State,
  checkpointSummary,
  findHistoryByNext,
  filterHistoryByNext,
  findInterruptAtNode,
  collectCheckpointIds,
  getTaskRunnableConfig,
  getTaskThreadId,
  historyHasNext,
  snapshotCheckpointId,
} from "./time_travel_helpers.js";

describe("Time Travel Tests (extended Python parity)", () => {
  beforeAll(() => {
    initializeAsyncLocalStorageSingleton();
  });

  describe("Replay and fork basics", () => {
    it("should rerun nodes after checkpoint on replay", async () => {
      const called: string[] = [];
      const graph = new StateGraph(State)
        .addNode("node_a", () => {
          called.push("node_a");
          return { value: ["a"] };
        })
        .addNode("node_b", () => {
          called.push("node_b");
          return { value: ["b"] };
        })
        .addEdge(START, "node_a")
        .addEdge("node_a", "node_b")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-basic-1" } };
      const result = await graph.invoke({ value: [] }, config);
      expect(result.value).toEqual(["a", "b"]);

      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeB = findHistoryByNext(history, "node_b");
      expect(beforeB).toBeDefined();

      called.length = 0;
      const replay = await graph.invoke(null, beforeB!.config);
      expect(replay.value).toEqual(["a", "b"]);
      expect(called).toContain("node_b");
      expect(called).not.toContain("node_a");
    });

    it("should no-op when replaying from final checkpoint", async () => {
      const called: string[] = [];
      const graph = new StateGraph(State)
        .addNode("node_a", () => {
          called.push("node_a");
          return { value: ["a"] };
        })
        .addEdge(START, "node_a")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-basic-2" } };
      await graph.invoke({ value: [] }, config);
      const state = await graph.getState(config);
      expect(state.next).toEqual([]);

      called.length = 0;
      const replay = await graph.invoke(null, state.config);
      expect(replay.value).toEqual(["a"]);
      expect(called).toEqual([]);
    });

    it("should rerun with modified state on fork", async () => {
      const called: string[] = [];
      const graph = new StateGraph(State)
        .addNode("node_a", () => {
          called.push("node_a");
          return { value: ["a"] };
        })
        .addNode("node_b", () => {
          called.push("node_b");
          return { value: ["b"] };
        })
        .addEdge(START, "node_a")
        .addEdge("node_a", "node_b")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-basic-3" } };
      await graph.invoke({ value: [] }, config);
      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeB = findHistoryByNext(history, "node_b");

      called.length = 0;
      const forkConfig = await graph.updateState(beforeB!.config, {
        value: ["x"],
      });
      const forkResult = await graph.invoke(null, forkConfig);
      expect(called).toContain("node_b");
      expect(forkResult.value).toEqual(["a", "x", "b"]);
    });

    it("should create independent branches from multiple forks", async () => {
      const graph = new StateGraph(State)
        .addNode("node_a", () => ({ value: ["a"] }))
        .addNode("node_b", () => ({ value: ["b"] }))
        .addEdge(START, "node_a")
        .addEdge("node_a", "node_b")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-basic-4" } };
      await graph.invoke({ value: [] }, config);
      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeB = findHistoryByNext(history, "node_b");

      const fork1Config = await graph.updateState(beforeB!.config, {
        value: ["fork1"],
      });
      const result1 = await graph.invoke(null, fork1Config);
      const fork2Config = await graph.updateState(beforeB!.config, {
        value: ["fork2"],
      });
      const result2 = await graph.invoke(null, fork2Config);

      expect(result1.value).toContain("fork1");
      expect(result1.value).not.toContain("fork2");
      expect(result2.value).toContain("fork2");
      expect(result2.value).not.toContain("fork1");
    });
  });

  describe("Interrupt replay and fork", () => {
    it("should produce stable interrupt results across repeated replays", async () => {
      const graph = new StateGraph(State)
        .addNode("node_a", () => ({ value: ["a"] }))
        .addNode("ask_human", () => {
          const answer = interrupt("What is your input?");
          return { value: [`human:${answer}`] };
        })
        .addNode("node_b", () => ({ value: ["b"] }))
        .addEdge(START, "node_a")
        .addEdge("node_a", "ask_human")
        .addEdge("ask_human", "node_b")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-int-1" } };
      await graph.invoke({ value: [] }, config);
      await graph.invoke(new Command({ resume: "cached_answer" }), config);

      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeAsk = filterHistoryByNext(history, "ask_human").at(-1);

      const results: Array<Awaited<ReturnType<typeof graph.invoke>>> = [];
      for (let i = 0; i < 3; i += 1) {
        results.push(await graph.invoke(null, beforeAsk!.config));
      }

      for (const r of results) {
        expect(r).toHaveInterruptValue("What is your input?");
      }
      const firstValue = results[0]?.value;
      expect(
        results.every((r) => JSON.stringify(r.value) === JSON.stringify(firstValue))
      ).toBe(true);
    });

    it("should re-fire interrupt on fork from before interrupt", async () => {
      const called: string[] = [];
      const graph = new StateGraph(State)
        .addNode("node_a", () => {
          called.push("node_a");
          return { value: ["a"] };
        })
        .addNode("ask_human", () => {
          called.push("ask_human");
          const answer = interrupt("What is your input?");
          return { value: [`human:${answer}`] };
        })
        .addNode("node_b", () => {
          called.push("node_b");
          return { value: ["b"] };
        })
        .addEdge(START, "node_a")
        .addEdge("node_a", "ask_human")
        .addEdge("ask_human", "node_b")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-int-2" } };
      await graph.invoke({ value: [] }, config);
      await graph.invoke(new Command({ resume: "hello" }), config);

      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeAsk = filterHistoryByNext(history, "ask_human").at(-1);

      called.length = 0;
      const forkConfig = await graph.updateState(beforeAsk!.config, {
        value: ["forked"],
      });
      const forkResult = await graph.invoke(null, forkConfig);
      expect(forkResult).toHaveInterruptValue("What is your input?");

      const final = await graph.invoke(
        new Command({ resume: "world" }),
        forkConfig
      );
      expect(final.value).toEqual(["a", "forked", "human:world", "b"]);
    });

    it("should re-fire interrupt on fork from interrupt checkpoint", async () => {
      const graph = new StateGraph(State)
        .addNode("node_a", () => ({ value: ["a"] }))
        .addNode("ask_human", () => {
          const answer = interrupt("What is your input?");
          return { value: [`human:${answer}`] };
        })
        .addNode("node_b", () => ({ value: ["b"] }))
        .addEdge(START, "node_a")
        .addEdge("node_a", "ask_human")
        .addEdge("ask_human", "node_b")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-int-3" } };
      await graph.invoke({ value: [] }, config);
      await graph.invoke(new Command({ resume: "hello" }), config);

      const history = await gatherIterator(graph.getStateHistory(config));
      const interruptCheckpoint = findInterruptAtNode(history, "ask_human");
      expect(interruptCheckpoint).toBeDefined();

      const forkConfig = await graph.updateState(interruptCheckpoint!.config, {
        value: ["forked"],
      });
      const forkResult = await graph.invoke(null, forkConfig);
      expect(forkResult).toBeInterrupted();

      const final = await graph.invoke(
        new Command({ resume: "different" }),
        forkConfig
      );
      expect(final.value).toContain("human:different");
    });

    it("should fork from between sequential interrupts preserving first answer", async () => {
      const called: string[] = [];
      const graph = new StateGraph(State)
        .addNode("node_a", () => {
          called.push("node_a");
          return { value: ["a"] };
        })
        .addNode("interrupt_1", () => {
          called.push("interrupt_1");
          const answer = interrupt("First question?");
          return { value: [`i1:${answer}`] };
        })
        .addNode("interrupt_2", () => {
          called.push("interrupt_2");
          const answer = interrupt("Second question?");
          return { value: [`i2:${answer}`] };
        })
        .addNode("node_b", () => {
          called.push("node_b");
          return { value: ["b"] };
        })
        .addEdge(START, "node_a")
        .addEdge("node_a", "interrupt_1")
        .addEdge("interrupt_1", "interrupt_2")
        .addEdge("interrupt_2", "node_b")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-int-4" } };
      await graph.invoke({ value: [] }, config);
      await graph.invoke(new Command({ resume: "ans1" }), config);
      await graph.invoke(new Command({ resume: "ans2" }), config);

      const history = await gatherIterator(graph.getStateHistory(config));
      const between = filterHistoryByNext(history, "interrupt_2").at(-1);
      const forkConfig = await graph.updateState(between!.config, {
        value: ["mid_fork"],
      });
      const forkResult = await graph.invoke(null, forkConfig);
      expect(forkResult).toHaveInterruptValue("Second question?");

      const final = await graph.invoke(new Command({ resume: "new_b" }), forkConfig);
      expect(final.value).toContain("i2:new_b");
      expect(final.value).toContain("i1:ans1");

      const beforeI1 = filterHistoryByNext(history, "interrupt_1").at(-1);
      called.length = 0;
      const replay = await graph.invoke(null, beforeI1!.config);
      expect(replay).toHaveInterruptValue("First question?");
      expect(called).toContain("interrupt_1");
      expect(called).not.toContain("interrupt_2");
    });

    it("should re-fire first interrupt when replaying before multi-interrupt node", async () => {
      const graph = new StateGraph(State)
        .addNode("ask", () => {
          const answer1 = interrupt("First question?");
          const answer2 = interrupt("Second question?");
          return { value: [`a1:${answer1}`, `a2:${answer2}`] };
        })
        .addNode("after", () => ({ value: ["done"] }))
        .addEdge(START, "ask")
        .addEdge("ask", "after")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-int-5" } };
      let result = await graph.invoke({ value: [] }, config);
      expect(result).toHaveInterruptValue("First question?");

      const interruptState = await graph.getState(config);
      result = await graph.invoke(
        new Command({ resume: "ans1" }),
        interruptState.config
      );
      expect(result).toHaveInterruptValue("Second question?");

      const interruptState2 = await graph.getState(config);
      result = await graph.invoke(
        new Command({ resume: "ans2" }),
        interruptState2.config
      );
      expect(result.value).toEqual(["a1:ans1", "a2:ans2", "done"]);

      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeAsk = filterHistoryByNext(history, "ask").at(-1);
      const replay = await graph.invoke(null, beforeAsk!.config);
      expect(replay).toHaveInterruptValue("First question?");
    });
  });

  describe("Subgraph without interrupt", () => {
    it("should replay parent checkpoint before subgraph", async () => {
      const called: string[] = [];
      const subgraph = new StateGraph(State)
        .addNode("step_a", () => {
          called.push("step_a");
          return { value: ["sub_a"] };
        })
        .addNode("step_b", () => {
          called.push("step_b");
          return { value: ["sub_b"] };
        })
        .addEdge(START, "step_a")
        .addEdge("step_a", "step_b")
        .compile();

      const graph = new StateGraph(State)
        .addNode("parent_node", () => {
          called.push("parent_node");
          return { value: ["parent"] };
        })
        .addNode("subgraph", subgraph)
        .addNode("post_process", () => {
          called.push("post_process");
          return { value: ["post"] };
        })
        .addEdge(START, "parent_node")
        .addEdge("parent_node", "subgraph")
        .addEdge("subgraph", "post_process")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-sub-1" } };
      const result = await graph.invoke({ value: [] }, config);
      expect(result.value).toContain("sub_a");
      expect(result.value).toContain("sub_b");
      expect(result.value).toContain("post");

      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeSub = findHistoryByNext(history, "subgraph");

      called.length = 0;
      const replay = await graph.invoke(null, beforeSub!.config);
      expect(replay.value).toContain("sub_a");
      expect(replay.value).toContain("sub_b");
      expect(replay.value).toContain("post");
      expect(called).not.toContain("parent_node");
    });

    it("should fork parent checkpoint before subgraph with modified state", async () => {
      const called: string[] = [];
      const subgraph = new StateGraph(State)
        .addNode("step_a", () => {
          called.push("step_a");
          return { value: ["sub_a"] };
        })
        .addNode("step_b", () => {
          called.push("step_b");
          return { value: ["sub_b"] };
        })
        .addEdge(START, "step_a")
        .addEdge("step_a", "step_b")
        .compile();

      const graph = new StateGraph(State)
        .addNode("parent_node", () => {
          called.push("parent_node");
          return { value: ["parent"] };
        })
        .addNode("subgraph", subgraph)
        .addNode("post_process", () => {
          called.push("post_process");
          return { value: ["post"] };
        })
        .addEdge(START, "parent_node")
        .addEdge("parent_node", "subgraph")
        .addEdge("subgraph", "post_process")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-sub-2" } };
      await graph.invoke({ value: [] }, config);
      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeSub = findHistoryByNext(history, "subgraph");

      called.length = 0;
      const forkConfig = await graph.updateState(beforeSub!.config, {
        value: ["forked"],
      });
      const forkResult = await graph.invoke(null, forkConfig);
      expect(called).toContain("step_a");
      expect(called).toContain("step_b");
      expect(called).toContain("post_process");
      expect(forkResult.value).toContain("forked");
    });
  });

  describe("Subgraph with interrupt (additional)", () => {
    const buildRouterSubgraphGraph = (subCheckpointer: true | undefined) => {
      const called: string[] = [];
      const subgraph = new StateGraph(State)
        .addNode("step_a", () => {
          called.push("step_a");
          return { value: ["sub_a"] };
        })
        .addNode("ask_human", () => {
          called.push("ask_human");
          const answer = interrupt("Provide input:");
          return { value: [`human:${answer}`] };
        })
        .addNode("step_b", () => {
          called.push("step_b");
          return { value: ["sub_b"] };
        })
        .addEdge(START, "step_a")
        .addEdge("step_a", "ask_human")
        .addEdge("ask_human", "step_b")
        .compile(
          subCheckpointer === true ? { checkpointer: true } : undefined
        );

      const graph = new StateGraph(State)
        .addNode("router", () => {
          called.push("router");
          return { value: ["routed"] };
        })
        .addNode("subgraph_node", subgraph)
        .addNode("post_process", () => {
          called.push("post_process");
          return { value: ["post"] };
        })
        .addEdge(START, "router")
        .addEdge("router", "subgraph_node")
        .addEdge("subgraph_node", "post_process")
        .compile({ checkpointer: new MemorySaver() });

      return { graph, called };
    };

    it("should replay from parent checkpoint before subgraph interrupt", async () => {
      const { graph, called } = buildRouterSubgraphGraph(true);
      const config = { configurable: { thread_id: "tt-subint-1" } };

      await graph.invoke({ value: [] }, config);
      await graph.invoke(new Command({ resume: "answer" }), config);

      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeSub = filterHistoryByNext(history, "subgraph_node").at(-1);

      called.length = 0;
      const replay = await graph.invoke(null, beforeSub!.config);
      expect(replay).toHaveInterruptValue("Provide input:");
      expect(called).toContain("step_a");
      expect(called).toContain("ask_human");
      expect(called).not.toContain("step_b");
    });

    it("should replay from parent interrupt checkpoint", async () => {
      const { graph, called } = buildRouterSubgraphGraph(true);
      const config = { configurable: { thread_id: "tt-subint-2" } };

      await graph.invoke({ value: [] }, config);
      const parentState = await graph.getState(config, { subgraphs: true });
      expect(parentState.tasks[0]?.state).toBeDefined();
      await graph.invoke(new Command({ resume: "answer" }), config);

      const history = await gatherIterator(graph.getStateHistory(config));
      const interruptCheckpoint = findInterruptAtNode(history, "subgraph_node");

      called.length = 0;
      const replay = await graph.invoke(null, interruptCheckpoint!.config);
      expect(replay).toBeInterrupted();
      expect(called).toContain("step_a");
      expect(called).toContain("ask_human");
      expect(called).not.toContain("step_b");
    });

    it("should fork and resume after replay from parent interrupt checkpoint", async () => {
      const { graph, called } = buildRouterSubgraphGraph(true);
      const config = { configurable: { thread_id: "tt-subint-3" } };

      await graph.invoke({ value: [] }, config);
      await graph.invoke(new Command({ resume: "old_answer" }), config);

      const originalHistory = await gatherIterator(
        graph.getStateHistory(config)
      );
      const interruptCheckpoint = findHistoryByNext(
        originalHistory,
        "subgraph_node"
      );

      called.length = 0;
      const replay = await graph.invoke(null, interruptCheckpoint!.config);
      expect(replay).toHaveInterruptValue("Provide input:");

      const postReplay = await gatherIterator(graph.getStateHistory(config));
      expect(postReplay.map((s: any) => s.next)).toEqual([
        ["subgraph_node"],
        [],
        ["post_process"],
        ["subgraph_node"],
        ["router"],
        ["__start__"],
      ]);
      expect(postReplay.map((s: any) => s.metadata?.source)).toEqual([
        "fork",
        "loop",
        "loop",
        "loop",
        "loop",
        "input",
      ]);

      called.length = 0;
      const final = await graph.invoke(
        new Command({ resume: "new_answer" }),
        config
      );
      expect(final).not.toBeInterrupted();
      expect(final.value).toContain("human:new_answer");
      expect(called).toContain("ask_human");
      expect(called).toContain("step_b");
      expect(called).toContain("post_process");
    });

    it("should complete flow when subgraph has no checkpointer", async () => {
      const { graph, called } = buildRouterSubgraphGraph(undefined);
      const config = { configurable: { thread_id: "tt-subint-4" } };

      await graph.invoke({ value: [] }, config);
      await graph.invoke(new Command({ resume: "original" }), config);

      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeSub = filterHistoryByNext(history, "subgraph_node").at(-1);

      called.length = 0;
      const forkConfig = await graph.updateState(beforeSub!.config, {
        value: ["forked"],
      });
      const forkResult = await graph.invoke(null, forkConfig);
      expect(forkResult).toHaveInterruptValue("Provide input:");

      called.length = 0;
      const final = await graph.invoke(
        new Command({ resume: "new_answer" }),
        forkConfig
      );
      expect(final.value).toContain("human:new_answer");
      expect(called).toContain("step_b");
      expect(called).toContain("post_process");
    });

    it("should replay from subgraph checkpoint via getState subgraphs", async () => {
      const { graph, called } = buildRouterSubgraphGraph(true);
      const config = { configurable: { thread_id: "tt-subint-5" } };

      await graph.invoke({ value: [] }, config);
      const parentState = await graph.getState(config, { subgraphs: true });
      const subConfig = getTaskRunnableConfig(parentState.tasks[0]!);
      expect(subConfig).toBeDefined();

      called.length = 0;
      const replay = await graph.invoke(null, subConfig!);
      expect(replay).toHaveInterruptValue("Provide input:");

      called.length = 0;
      const final = await graph.invoke(
        new Command({ resume: "replayed_answer" }),
        subConfig!
      );
      expect(called).toContain("ask_human");
      expect(final.value).toContain("human:replayed_answer");
      expect(called).toContain("step_b");
      expect(called).toContain("post_process");
    });
  });

  describe("Copy fork and update_state", () => {
    it("should retrigger interrupt on __copy__ fork", async () => {
      const called: string[] = [];
      const graph = new StateGraph(State)
        .addNode("node_a", () => {
          called.push("node_a");
          return { value: ["a"] };
        })
        .addNode("ask_human", () => {
          called.push("ask_human");
          const answer = interrupt("What is your input?");
          return { value: [`human:${answer}`] };
        })
        .addNode("node_b", () => {
          called.push("node_b");
          return { value: ["b"] };
        })
        .addEdge(START, "node_a")
        .addEdge("node_a", "ask_human")
        .addEdge("ask_human", "node_b")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-copy-1" } };
      await graph.invoke({ value: [] }, config);
      await graph.invoke(new Command({ resume: "hello" }), config);

      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeAsk = filterHistoryByNext(history, "ask_human").at(-1);

      const forkConfig = await graph.updateState(beforeAsk!.config, null, COPY);
      const forkResult = await graph.invoke(null, forkConfig);
      expect(forkResult).toHaveInterruptValue("What is your input?");

      const final = await graph.invoke(
        new Command({ resume: "new_answer" }),
        forkConfig
      );
      expect(final.value).toEqual(["a", "human:new_answer", "b"]);
    });

    it("should distinguish __copy__ fork metadata from update fork", async () => {
      const graph = new StateGraph(State)
        .addNode("node_a", () => ({ value: ["a"] }))
        .addNode("node_b", () => ({ value: ["b"] }))
        .addEdge(START, "node_a")
        .addEdge("node_a", "node_b")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-copy-2" } };
      await graph.invoke({ value: [] }, config);
      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeB = findHistoryByNext(history, "node_b");

      const copyConfig = await graph.updateState(beforeB!.config, null, COPY);
      const copyState = await graph.getState(copyConfig);
      expect(copyState.metadata?.source).toBe("fork");

      const regularConfig = await graph.updateState(beforeB!.config, {
        value: ["x"],
      });
      const regularState = await graph.getState(regularConfig);
      expect(regularState.metadata?.source).toBe("update");
    });

    it("should retrigger interrupt on update_state with null values", async () => {
      const graph = new StateGraph(State)
        .addNode("node_a", () => ({ value: ["a"] }))
        .addNode("ask_human", () => {
          const answer = interrupt("What is your input?");
          return { value: [`human:${answer}`] };
        })
        .addNode("node_b", () => ({ value: ["b"] }))
        .addEdge(START, "node_a")
        .addEdge("node_a", "ask_human")
        .addEdge("ask_human", "node_b")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-copy-3" } };
      await graph.invoke({ value: [] }, config);
      await graph.invoke(new Command({ resume: "hello" }), config);

      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeAsk = filterHistoryByNext(history, "ask_human").at(-1);

      const forkConfig = await graph.updateState(beforeAsk!.config, null);
      const forkResult = await graph.invoke(null, forkConfig);
      expect(forkResult).toHaveInterruptValue("What is your input?");

      const forkState = await graph.getState(forkConfig);
      expect(forkState.metadata?.source).toBe("update");
    });
  });

  describe("Stateful subgraph replay", () => {
    it("should retain accumulated subgraph state on parent replay", async () => {
      const SubState = Annotation.Root({
        value: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });
      const ParentState = Annotation.Root({
        results: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });

      const started: Array<[string, typeof SubState.State]> = [];
      const observed: Array<[string, typeof SubState.State]> = [];

      const sub = new StateGraph(SubState)
        .addNode("step_a", (state) => {
          started.push(["step_a", { ...state }]);
          const answer = interrupt("question_a");
          observed.push(["step_a", { ...state }]);
          return { value: [`a:${answer}`] };
        })
        .addNode("step_b", (state) => {
          started.push(["step_b", { ...state }]);
          const answer = interrupt("question_b");
          observed.push(["step_b", { ...state }]);
          return { value: [`b:${answer}`] };
        })
        .addEdge(START, "step_a")
        .addEdge("step_a", "step_b")
        .compile({ checkpointer: true });

      const graph = new StateGraph(ParentState)
        .addNode("parent_node", () => ({ results: ["p"] }))
        .addNode("sub_node", sub)
        .addEdge(START, "parent_node")
        .addEdge("parent_node", "sub_node")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-stateful-1" } };

      await graph.invoke({ results: [] }, config);
      await graph.invoke(new Command({ resume: "a1" }), config);
      await graph.invoke(new Command({ resume: "b1" }), config);
      expect(observed[0]).toEqual(["step_a", { value: [] }]);
      expect(observed[1]).toEqual(["step_b", { value: ["a:a1"] }]);

      observed.length = 0;
      await graph.invoke({ results: [] }, config);
      await graph.invoke(new Command({ resume: "a2" }), config);
      await graph.invoke(new Command({ resume: "b2" }), config);
      expect(observed[0]).toEqual(["step_a", { value: ["a:a1", "b:b1"] }]);
      expect(observed[1]).toEqual([
        "step_b",
        { value: ["a:a1", "b:b1", "a:a2"] },
      ]);

      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeSub2nd = filterHistoryByNext(history, "sub_node")[0];

      started.length = 0;
      const replay = await graph.invoke(null, beforeSub2nd.config);
      expect(replay).toBeInterrupted();
      expect(started[0]).toEqual(["step_a", { value: ["a:a1", "b:b1"] }]);
    });

    it("should start stateless subgraph fresh on parent replay", async () => {
      const SubState = Annotation.Root({
        value: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });
      const ParentState = Annotation.Root({
        results: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });

      const started: Array<[string, typeof SubState.State]> = [];
      const observed: Array<[string, typeof SubState.State]> = [];

      const sub = new StateGraph(SubState)
        .addNode("step_a", (state) => {
          started.push(["step_a", { ...state }]);
          const answer = interrupt("question_a");
          observed.push(["step_a", { ...state }]);
          return { value: [`a:${answer}`] };
        })
        .addNode("step_b", (state) => {
          started.push(["step_b", { ...state }]);
          const answer = interrupt("question_b");
          observed.push(["step_b", { ...state }]);
          return { value: [`b:${answer}`] };
        })
        .addEdge(START, "step_a")
        .addEdge("step_a", "step_b")
        .compile();

      const graph = new StateGraph(ParentState)
        .addNode("parent_node", () => ({ results: ["p"] }))
        .addNode("sub_node", sub)
        .addEdge(START, "parent_node")
        .addEdge("parent_node", "sub_node")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-stateful-2" } };

      await graph.invoke({ results: [] }, config);
      await graph.invoke(new Command({ resume: "a1" }), config);
      await graph.invoke(new Command({ resume: "b1" }), config);
      expect(observed[0]).toEqual(["step_a", { value: [] }]);
      expect(observed[1]).toEqual(["step_b", { value: ["a:a1"] }]);

      observed.length = 0;
      await graph.invoke({ results: [] }, config);
      await graph.invoke(new Command({ resume: "a2" }), config);
      await graph.invoke(new Command({ resume: "b2" }), config);
      expect(observed[0]).toEqual(["step_a", { value: [] }]);
      expect(observed[1]).toEqual(["step_b", { value: ["a:a2"] }]);

      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeSub2nd = filterHistoryByNext(history, "sub_node")[0];

      started.length = 0;
      const replay = await graph.invoke(null, beforeSub2nd.config);
      expect(replay).toBeInterrupted();
      expect(started[0]).toEqual(["step_a", { value: [] }]);
    });
  });

  describe("Append-only checkpoint history", () => {
    it("should preserve original checkpoints when replay creates branch", async () => {
      let callCount = 0;
      const graph = new StateGraph(State)
        .addNode("node_a", () => ({ value: ["a"] }))
        .addNode("node_b", () => {
          callCount += 1;
          return { value: [`b${callCount}`] };
        })
        .addNode("node_c", () => ({ value: ["c"] }))
        .addEdge(START, "node_a")
        .addEdge("node_a", "node_b")
        .addEdge("node_b", "node_c")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-branch-1" } };
      const result = await graph.invoke({ value: [] }, config);
      expect(result.value).toEqual(["a", "b1", "c"]);

      const originalHistory = await gatherIterator(
        graph.getStateHistory(config)
      );
      const originalSummary = checkpointSummary(originalHistory);
      expect(originalSummary.length).toBe(5);
      expect(originalSummary.map((s) => s.next)).toEqual([
        [],
        ["node_c"],
        ["node_b"],
        ["node_a"],
        ["__start__"],
      ]);

      const originalIds = collectCheckpointIds(originalHistory);

      const beforeB = findHistoryByNext(originalHistory, "node_b");
      const beforeBId = snapshotCheckpointId(beforeB!);
      expect(beforeBId).toBeDefined();
      const replay = await graph.invoke(null, beforeB!.config);
      expect(replay.value).toEqual(["a", "b2", "c"]);

      const postHistory = await gatherIterator(graph.getStateHistory(config));
      const postSummary = checkpointSummary(postHistory);
      expect(postSummary.length).toBe(8);
      expect(postSummary.map((s) => s.next)).toEqual([
        [],
        ["node_c"],
        ["node_b"],
        [],
        ["node_c"],
        ["node_b"],
        ["node_a"],
        ["__start__"],
      ]);

      const postIds = collectCheckpointIds(postHistory);
      for (const id of originalIds) {
        expect(postIds.has(id)).toBe(true);
      }

      const forkCheckpoint = postHistory.find(
        (s) =>
          s.metadata?.source === "fork" &&
          !originalIds.has(snapshotCheckpointId(s) ?? "")
      );
      expect(forkCheckpoint?.parentConfig?.configurable?.checkpoint_id).toBe(
        beforeBId
      );

      const latest = await graph.getState(config);
      expect(latest.values).toEqual({ value: ["a", "b2", "c"] });
      expect(originalIds.has(latest.config.configurable?.checkpoint_id)).toBe(
        false
      );
    });

    it("should preserve original checkpoints when replay creates subgraph branch", async () => {
      let subCallCount = 0;
      const SubState = Annotation.Root({
        subValue: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });
      const ParentState = Annotation.Root({
        value: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
        subValue: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });

      const sub = new StateGraph(SubState)
        .addNode("sub_step", () => {
          subCallCount += 1;
          return { subValue: [`sub${subCallCount}`] };
        })
        .addEdge(START, "sub_step")
        .compile();

      const graph = new StateGraph(ParentState)
        .addNode("parent_start", () => ({ value: ["p_start"] }))
        .addNode("sub_graph", sub)
        .addNode("parent_end", () => ({ value: ["p_end"] }))
        .addEdge(START, "parent_start")
        .addEdge("parent_start", "sub_graph")
        .addEdge("sub_graph", "parent_end")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-branch-sub-1" } };
      const result = await graph.invoke(
        { value: [], subValue: [] },
        config
      );
      expect(result).toEqual({
        value: ["p_start", "p_end"],
        subValue: ["sub1"],
      });

      const originalHistory = await gatherIterator(
        graph.getStateHistory(config)
      );
      const originalIds = collectCheckpointIds(originalHistory);
      const beforeSub = findHistoryByNext(originalHistory, "sub_graph");
      const beforeSubId = snapshotCheckpointId(beforeSub!);
      expect(beforeSubId).toBeDefined();

      const replay = await graph.invoke(null, beforeSub!.config);
      expect(replay).toEqual({
        value: ["p_start", "p_end"],
        subValue: ["sub2"],
      });

      const postHistory = await gatherIterator(graph.getStateHistory(config));
      const postIds = collectCheckpointIds(postHistory);
      for (const id of originalIds) {
        expect(postIds.has(id)).toBe(true);
      }

      const newIds = [...postIds].filter((id) => !originalIds.has(id));
      expect(newIds.length).toBeGreaterThanOrEqual(2);

      const forkCheckpoint = postHistory.find(
        (s) =>
          s.metadata?.source === "fork" &&
          !originalIds.has(snapshotCheckpointId(s) ?? "")
      );
      expect(forkCheckpoint?.parentConfig?.configurable?.checkpoint_id).toBe(
        beforeSubId
      );

      const latest = await graph.getState(config);
      expect(newIds).toContain(latest.config.configurable?.checkpoint_id);
      expect(latest.values).toEqual({
        value: ["p_start", "p_end"],
        subValue: ["sub2"],
      });
    });

    it("should preserve original checkpoints when fork creates branch", async () => {
      let callCount = 0;
      const graph = new StateGraph(State)
        .addNode("node_a", () => ({ value: ["a"] }))
        .addNode("node_b", () => {
          callCount += 1;
          return { value: [`b${callCount}`] };
        })
        .addNode("node_c", () => ({ value: ["c"] }))
        .addEdge(START, "node_a")
        .addEdge("node_a", "node_b")
        .addEdge("node_b", "node_c")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-branch-fork-1" } };
      await graph.invoke({ value: [] }, config);

      const originalHistory = await gatherIterator(
        graph.getStateHistory(config)
      );
      const originalSummary = checkpointSummary(originalHistory);
      expect(originalSummary.length).toBe(5);

      const originalIds = collectCheckpointIds(originalHistory);
      const beforeB = findHistoryByNext(originalHistory, "node_b");
      const beforeBId = snapshotCheckpointId(beforeB!);
      expect(beforeBId).toBeDefined();

      const forkConfig = await graph.updateState(beforeB!.config, {
        value: ["x"],
      });
      const forkResult = await graph.invoke(null, forkConfig);
      expect(forkResult.value).toEqual(["a", "x", "b2", "c"]);

      const postHistory = await gatherIterator(graph.getStateHistory(config));
      const postSummary = checkpointSummary(postHistory);
      expect(postSummary.length).toBe(8);
      expect(postSummary.map((s) => s.values)).toEqual([
        { value: ["a", "x", "b2", "c"] },
        { value: ["a", "x", "b2"] },
        { value: ["a", "x"] },
        { value: ["a", "b1", "c"] },
        { value: ["a", "b1"] },
        { value: ["a"] },
        { value: [] },
        { value: [] },
      ]);

      const postIds = collectCheckpointIds(postHistory);
      for (const id of originalIds) {
        expect(postIds.has(id)).toBe(true);
      }

      const updateCheckpoint = postHistory.find(
        (s) =>
          s.metadata?.source === "update" &&
          !originalIds.has(snapshotCheckpointId(s) ?? "")
      );
      expect(updateCheckpoint?.parentConfig?.configurable?.checkpoint_id).toBe(
        beforeBId
      );

      const latest = await graph.getState(config);
      expect(latest.values).toEqual({ value: ["a", "x", "b2", "c"] });
      expect(originalIds.has(latest.config.configurable?.checkpoint_id)).toBe(
        false
      );
    });

    it("should preserve original checkpoints when fork creates subgraph branch", async () => {
      let subCallCount = 0;
      const SubState = Annotation.Root({
        subValue: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });
      const ParentState = Annotation.Root({
        value: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
        subValue: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });

      const sub = new StateGraph(SubState)
        .addNode("sub_step", () => {
          subCallCount += 1;
          return { subValue: [`sub${subCallCount}`] };
        })
        .addEdge(START, "sub_step")
        .compile();

      const graph = new StateGraph(ParentState)
        .addNode("parent_start", () => ({ value: ["p_start"] }))
        .addNode("sub_graph", sub)
        .addNode("parent_end", () => ({ value: ["p_end"] }))
        .addEdge(START, "parent_start")
        .addEdge("parent_start", "sub_graph")
        .addEdge("sub_graph", "parent_end")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-branch-fork-sub-1" } };
      await graph.invoke({ value: [], subValue: [] }, config);

      const originalHistory = await gatherIterator(
        graph.getStateHistory(config)
      );
      const originalIds = collectCheckpointIds(originalHistory);
      const beforeSub = findHistoryByNext(originalHistory, "sub_graph");
      const beforeSubId = snapshotCheckpointId(beforeSub!);
      expect(beforeSubId).toBeDefined();

      const forkConfig = await graph.updateState(beforeSub!.config, {
        value: ["extra"],
      });
      const forkResult = await graph.invoke(null, forkConfig);
      expect(forkResult).toEqual({
        value: ["p_start", "extra", "p_end"],
        subValue: ["sub2"],
      });

      const postHistory = await gatherIterator(graph.getStateHistory(config));
      const postIds = collectCheckpointIds(postHistory);
      for (const id of originalIds) {
        expect(postIds.has(id)).toBe(true);
      }

      const newIds = [...postIds].filter((id) => !originalIds.has(id));
      expect(newIds.length).toBeGreaterThanOrEqual(3);

      const updateCheckpoint = postHistory.find(
        (s) =>
          s.metadata?.source === "update" &&
          newIds.includes(snapshotCheckpointId(s) ?? "")
      );
      expect(updateCheckpoint?.parentConfig?.configurable?.checkpoint_id).toBe(
        beforeSubId
      );

      const latest = await graph.getState(config);
      expect(newIds).toContain(latest.config.configurable?.checkpoint_id);
      expect(latest.values).toEqual({
        value: ["p_start", "extra", "p_end"],
        subValue: ["sub2"],
      });
    });
  });

  describe("Observability", () => {
    it("should return subgraph state from getState with subgraphs option", async () => {
      const SubState = Annotation.Root({
        data: Annotation<string>(),
      });
      const ParentState = Annotation.Root({
        data: Annotation<string>(),
      });

      const subgraph = new StateGraph(SubState)
        .addNode("process", () => {
          interrupt("Continue?");
          return { data: "processed" };
        })
        .addEdge(START, "process")
        .compile();

      const graph = new StateGraph(ParentState)
        .addNode("sub", subgraph)
        .addEdge(START, "sub")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-obs-1" } };
      await graph.invoke({ data: "input" }, config);

      const state = await graph.getState(config, { subgraphs: true });
      expect(state.tasks.length).toBeGreaterThan(0);
      expect(state.tasks[0]?.state).toBeDefined();
      expect(getTaskThreadId(state.tasks[0]!)).toBe("tt-obs-1");
    });

    it("should expose checkpoint_ns and thread_id inside subgraph nodes", async () => {
      const captured: Record<string, string | undefined> = {};
      const SubState = Annotation.Root({
        data: Annotation<string>(),
      });
      const ParentState = Annotation.Root({
        data: Annotation<string>(),
      });

      const subgraph = new StateGraph(SubState)
        .addNode(
          "inner",
          (_state, config: LangGraphRunnableConfig) => {
            captured.checkpoint_ns =
              config.configurable?.checkpoint_ns as string | undefined;
            captured.thread_id = config.configurable?.thread_id as
              | string
              | undefined;
            return { data: "done" };
          }
        )
        .addEdge(START, "inner")
        .compile();

      const graph = new StateGraph(ParentState)
        .addNode("outer", subgraph)
        .addEdge(START, "outer")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-obs-2" } };
      await graph.invoke({ data: "test" }, config);

      expect(captured.checkpoint_ns).toBeTruthy();
      expect(captured.thread_id).toBe("tt-obs-2");
    });
  });

  describe("Nested and parallel subgraph state on replay", () => {
    it("should load subgraph state from first invocation on replay", async () => {
      const observed: Array<[string, { value: string[] }]> = [];
      const SubState = Annotation.Root({
        value: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });
      const ParentState = Annotation.Root({
        results: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });

      const sub = new StateGraph(SubState)
        .addNode("sub_step", (state) => {
          observed.push(["sub_step", { value: [...state.value] }]);
          return { value: ["s"] };
        })
        .addEdge(START, "sub_step")
        .compile({ checkpointer: true });

      const graph = new StateGraph(ParentState)
        .addNode("parent_node", () => ({ results: ["p"] }))
        .addNode("sub_node", sub)
        .addEdge(START, "parent_node")
        .addEdge("parent_node", "sub_node")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-nested-1" } };
      await graph.invoke({ results: [] }, config);
      await graph.invoke({ results: [] }, config);

      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeSub1st = filterHistoryByNext(history, "sub_node").at(-1);

      observed.length = 0;
      await graph.invoke(null, beforeSub1st!.config);
      expect(observed[0]).toEqual(["sub_step", { value: [] }]);
    });

    it("should load latest subgraph state after parent replay on next invoke", async () => {
      const observed: Array<[string, { value: string[] }]> = [];
      const SubState = Annotation.Root({
        value: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });
      const ParentState = Annotation.Root({
        results: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });

      const sub = new StateGraph(SubState)
        .addNode("sub_step", (state) => {
          observed.push(["sub_step", { value: [...state.value] }]);
          return { value: ["s"] };
        })
        .addEdge(START, "sub_step")
        .compile({ checkpointer: true });

      const graph = new StateGraph(ParentState)
        .addNode("parent_node", () => ({ results: ["p"] }))
        .addNode("sub_node", sub)
        .addEdge(START, "parent_node")
        .addEdge("parent_node", "sub_node")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-nested-2" } };
      await graph.invoke({ results: [] }, config);
      expect(observed.at(-1)).toEqual(["sub_step", { value: [] }]);

      await graph.invoke({ results: [] }, config);
      expect(observed.at(-1)).toEqual(["sub_step", { value: ["s"] }]);

      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeParent2nd = filterHistoryByNext(history, "parent_node")[0];

      observed.length = 0;
      await graph.invoke(null, beforeParent2nd.config);
      expect(observed[0]).toEqual(["sub_step", { value: ["s"] }]);

      observed.length = 0;
      await graph.invoke({ results: [] }, config);
      expect(observed[0]).toEqual(["sub_step", { value: ["s", "s"] }]);
    });

    it("should load correct state at all three nesting levels on replay", async () => {
      const observed: Array<[string, Record<string, string[]>]> = [];
      const InnerState = Annotation.Root({
        innerTrail: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });
      const MidState = Annotation.Root({
        midTrail: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });
      const ParentState = Annotation.Root({
        results: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });

      const inner = new StateGraph(InnerState)
        .addNode("inner_step", (state) => {
          observed.push([
            "inner_step",
            { innerTrail: [...state.innerTrail] },
          ]);
          return { innerTrail: ["inner"] };
        })
        .addEdge(START, "inner_step")
        .compile({ checkpointer: true });

      const mid = new StateGraph(MidState)
        .addNode("mid_step", (state) => {
          observed.push(["mid_step", { midTrail: [...state.midTrail] }]);
          return { midTrail: ["mid"] };
        })
        .addNode("inner_node", inner)
        .addEdge(START, "mid_step")
        .addEdge("mid_step", "inner_node")
        .compile({ checkpointer: true });

      const graph = new StateGraph(ParentState)
        .addNode("parent_step", () => ({ results: ["p"] }))
        .addNode("mid_node", mid)
        .addEdge(START, "parent_step")
        .addEdge("parent_step", "mid_node")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-nested-3" } };
      await graph.invoke({ results: [] }, config);
      expect(observed).toEqual([
        ["mid_step", { midTrail: [] }],
        ["inner_step", { innerTrail: [] }],
      ]);

      observed.length = 0;
      await graph.invoke({ results: [] }, config);
      expect(observed).toEqual([
        ["mid_step", { midTrail: ["mid"] }],
        ["inner_step", { innerTrail: ["inner"] }],
      ]);

      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeParent2nd = filterHistoryByNext(history, "parent_step")[0];

      observed.length = 0;
      await graph.invoke(null, beforeParent2nd.config);
      expect(observed).toEqual([
        ["mid_step", { midTrail: ["mid"] }],
        ["inner_step", { innerTrail: ["inner"] }],
      ]);

      observed.length = 0;
      await graph.invoke({ results: [] }, config);
      expect(observed).toEqual([
        ["mid_step", { midTrail: ["mid", "mid"] }],
        ["inner_step", { innerTrail: ["inner", "inner"] }],
      ]);
    });

    it("should load correct nested state on fork", async () => {
      const observed: Array<[string, Record<string, string[]>]> = [];
      const InnerState = Annotation.Root({
        innerTrail: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });
      const MidState = Annotation.Root({
        midTrail: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });
      const ParentState = Annotation.Root({
        results: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });

      const inner = new StateGraph(InnerState)
        .addNode("inner_step", (state) => {
          observed.push([
            "inner_step",
            { innerTrail: [...state.innerTrail] },
          ]);
          return { innerTrail: ["inner"] };
        })
        .addEdge(START, "inner_step")
        .compile({ checkpointer: true });

      const mid = new StateGraph(MidState)
        .addNode("mid_step", (state) => {
          observed.push(["mid_step", { midTrail: [...state.midTrail] }]);
          return { midTrail: ["mid"] };
        })
        .addNode("inner_node", inner)
        .addEdge(START, "mid_step")
        .addEdge("mid_step", "inner_node")
        .compile({ checkpointer: true });

      const graph = new StateGraph(ParentState)
        .addNode("parent_step", () => ({ results: ["p"] }))
        .addNode("mid_node", mid)
        .addEdge(START, "parent_step")
        .addEdge("parent_step", "mid_node")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-nested-4" } };
      await graph.invoke({ results: [] }, config);
      await graph.invoke({ results: [] }, config);

      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeParent2nd = filterHistoryByNext(history, "parent_step")[0];
      const forkConfig = await graph.updateState(beforeParent2nd.config, {
        results: ["forked"],
      });

      observed.length = 0;
      await graph.invoke(null, forkConfig);
      expect(observed).toEqual([
        ["mid_step", { midTrail: ["mid"] }],
        ["inner_step", { innerTrail: ["inner"] }],
      ]);
    });

    it("should load correct state for parallel sibling subgraphs on replay", async () => {
      const observed: Array<[string, Record<string, string[]>]> = [];
      const SubStateA = Annotation.Root({
        aTrail: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });
      const SubStateB = Annotation.Root({
        bTrail: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });
      const ParentState = Annotation.Root({
        results: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });

      const subA = new StateGraph(SubStateA)
        .addNode("sub_a_step", (state) => {
          observed.push(["sub_a", { aTrail: [...state.aTrail] }]);
          return { aTrail: ["a"] };
        })
        .addEdge(START, "sub_a_step")
        .compile({ checkpointer: true });

      const subB = new StateGraph(SubStateB)
        .addNode("sub_b_step", (state) => {
          observed.push(["sub_b", { bTrail: [...state.bTrail] }]);
          return { bTrail: ["b"] };
        })
        .addEdge(START, "sub_b_step")
        .compile({ checkpointer: true });

      const graph = new StateGraph(ParentState)
        .addNode("parent_step", () => ({ results: ["p"] }))
        .addNode("sub_a_node", subA)
        .addNode("sub_b_node", subB)
        .addEdge(START, "parent_step")
        .addEdge("parent_step", "sub_a_node")
        .addEdge("parent_step", "sub_b_node")
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-parallel-1" } };
      await graph.invoke({ results: [] }, config);
      expect(observed.filter((o) => o[0] === "sub_a")[0]).toEqual([
        "sub_a",
        { aTrail: [] },
      ]);
      expect(observed.filter((o) => o[0] === "sub_b")[0]).toEqual([
        "sub_b",
        { bTrail: [] },
      ]);

      observed.length = 0;
      await graph.invoke({ results: [] }, config);
      expect(observed.filter((o) => o[0] === "sub_a")[0]).toEqual([
        "sub_a",
        { aTrail: ["a"] },
      ]);
      expect(observed.filter((o) => o[0] === "sub_b")[0]).toEqual([
        "sub_b",
        { bTrail: ["b"] },
      ]);

      const history = await gatherIterator(graph.getStateHistory(config));
      const beforeParent2nd = filterHistoryByNext(history, "parent_step")[0];

      observed.length = 0;
      await graph.invoke(null, beforeParent2nd.config);
      expect(observed.filter((o) => o[0] === "sub_a")[0]).toEqual([
        "sub_a",
        { aTrail: ["a"] },
      ]);
      expect(observed.filter((o) => o[0] === "sub_b")[0]).toEqual([
        "sub_b",
        { bTrail: ["b"] },
      ]);

      observed.length = 0;
      await graph.invoke({ results: [] }, config);
      expect(observed.filter((o) => o[0] === "sub_a")[0]).toEqual([
        "sub_a",
        { aTrail: ["a", "a"] },
      ]);
      expect(observed.filter((o) => o[0] === "sub_b")[0]).toEqual([
        "sub_b",
        { bTrail: ["b", "b"] },
      ]);
    });

    it("should load subgraph state correctly when subgraph runs in a loop", async () => {
      const observed: Array<[string, { subTrail: string[] }]> = [];
      const SubState = Annotation.Root({
        subTrail: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });
      const ParentState = Annotation.Root({
        counter: Annotation<number>({
          reducer: (_, b) => b,
          default: () => 0,
        }),
        results: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });

      const sub = new StateGraph(SubState)
        .addNode("sub_step", (state) => {
          observed.push(["sub_step", { subTrail: [...state.subTrail] }]);
          return { subTrail: ["s"] };
        })
        .addEdge(START, "sub_step")
        .compile({ checkpointer: true });

      const graph = new StateGraph(ParentState)
        .addNode("inc", (state) => ({
          counter: state.counter + 1,
          results: [`inc:${state.counter}`],
        }))
        .addNode("sub_node", sub)
        .addEdge(START, "inc")
        .addEdge("inc", "sub_node")
        .addConditionalEdges("sub_node", (state) =>
          state.counter < 2 ? "inc" : END
        )
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "tt-loop-1" } };
      await graph.invoke({ counter: 0, results: [] }, config);
      expect(observed).toEqual([
        ["sub_step", { subTrail: [] }],
        ["sub_step", { subTrail: ["s"] }],
      ]);

      observed.length = 0;
      await graph.invoke({ counter: 0, results: [] }, config);
      expect(observed).toEqual([
        ["sub_step", { subTrail: ["s", "s"] }],
        ["sub_step", { subTrail: ["s", "s", "s"] }],
      ]);

      const history = await gatherIterator(graph.getStateHistory(config));
      const startOfLoop2nd = history.find(
        (s) => historyHasNext(s, "inc") && s.values?.counter === 0
      );
      expect(startOfLoop2nd).toBeDefined();

      observed.length = 0;
      await graph.invoke(null, startOfLoop2nd!.config);
      expect(observed).toEqual([
        ["sub_step", { subTrail: ["s", "s"] }],
        ["sub_step", { subTrail: ["s", "s", "s"] }],
      ]);

      const midLoop2nd = history.find(
        (s) => historyHasNext(s, "inc") && s.values?.counter === 1
      );
      expect(midLoop2nd).toBeDefined();

      observed.length = 0;
      await graph.invoke(null, midLoop2nd!.config);
      expect(observed).toEqual([["sub_step", { subTrail: ["s", "s", "s"] }]]);
    });
  });
});
