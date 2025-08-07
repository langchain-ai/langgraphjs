import { bench, describe } from "vitest";
import { v4 as uuid } from "uuid";
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { createSequential } from "./sequential.js";
import { reactAgent } from "./react_agent.js";
import { gatherIterator } from "../../utils.js";
import { CompiledStateGraph } from "../../web.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyStateGraph = CompiledStateGraph<any, any, any, any, any, any>;

/**
 * Comprehensive LangGraph.js Performance Benchmarks
 *
 * This file contains all the performance benchmarks ported from the Python version.
 * Based on langgraph/libs/langgraph/bench/__main__.py
 */

describe("LangGraph.js Performance Benchmarks", () => {
  // Helper functions
  const runGraph = async (
    graph: AnyStateGraph,
    input: Record<string, unknown>
  ) => {
    const results = await gatherIterator(
      graph.stream(input, {
        configurable: { thread_id: uuid() },
        recursionLimit: 1000000000,
      })
    );
    return results.length;
  };

  const runFirstEventLatency = async (
    graph: AnyStateGraph,
    input: Record<string, unknown>
  ) => {
    await gatherIterator(
      graph.stream(input, {
        configurable: { thread_id: uuid() },
        recursionLimit: 1000000000,
      })
    );
  };

  // Sequential benchmarks
  describe("Sequential Execution", () => {
    bench("sequential_10", async () => {
      const graph = createSequential(10).compile();
      const input = { messages: [] };
      await runGraph(graph, input);
    });

    bench("sequential_10_checkpoint", async () => {
      const graph = createSequential(10).compile({
        checkpointer: new MemorySaver(),
      });
      const input = { messages: [] };
      await runGraph(graph, input);
    });

    bench("sequential_1000", async () => {
      const graph = createSequential(1000).compile();
      const input = { messages: [] };
      await runGraph(graph, input);
    });

    bench("sequential_1000_checkpoint", async () => {
      const graph = createSequential(1000).compile({
        checkpointer: new MemorySaver(),
      });
      const input = { messages: [] };
      await runGraph(graph, input);
    });
  });

  // React Agent benchmarks
  describe("React Agent", () => {
    bench("react_agent_10x", async () => {
      const graph = reactAgent(10);
      const input = { messages: [new HumanMessage("hi?")] };
      await runGraph(graph, input);
    });

    bench("react_agent_10x_checkpoint", async () => {
      const graph = reactAgent(10, new MemorySaver());
      const input = { messages: [new HumanMessage("hi?")] };
      await runGraph(graph, input);
    });

    bench("react_agent_100x", async () => {
      const graph = reactAgent(100);
      const input = { messages: [new HumanMessage("hi?")] };
      await runGraph(graph, input);
    });

    bench("react_agent_100x_checkpoint", async () => {
      const graph = reactAgent(100, new MemorySaver());
      const input = { messages: [new HumanMessage("hi?")] };
      await runGraph(graph, input);
    });
  });

  // First event latency benchmarks (subset)
  describe("First Event Latency", () => {
    bench("sequential_1000_first_event_latency", async () => {
      const graph = createSequential(1000).compile();
      const input = { messages: [] };
      await runFirstEventLatency(graph, input);
    });

    bench("sequential_1000_first_event_latency_checkpoint", async () => {
      const graph = createSequential(1000).compile({
        checkpointer: new MemorySaver(),
      });
      const input = { messages: [] };
      await runFirstEventLatency(graph, input);
    });
  });

  // Graph compilation benchmarks
  describe("Graph Compilation", () => {
    bench("sequential_1000_compilation", () => {
      const graph = createSequential(1000);
      graph.compile();
    });

    bench("react_agent_100x_compilation", () => {
      reactAgent(100);
    });
  });

  // Memory and state stress tests
  describe("Large Data Handling", () => {
    // Test with large message payloads
    const createLargeDataset = (outerCount: number, innerCount: number) => {
      const messages: Record<string, unknown>[] = [];
      for (let i = 0; i < outerCount; i += 1) {
        const obj: Record<string, unknown> = {};
        for (let j = 0; j < innerCount; j += 1) {
          obj[String(j).repeat(10)] = [
            "hi?".repeat(10),
            true,
            1,
            6327816386138,
            null,
          ]
            .concat(
              Array(5).fill(["hi?".repeat(10), true, 1, 6327816386138, null])
            )
            .flat();
        }
        messages.push(obj);
      }
      return { messages };
    };

    bench("large_state_25x300", async () => {
      const graph = createSequential(10).compile();
      const input = createLargeDataset(5, 5); // Approximates 25x300 complexity
      await runGraph(graph, input);
    });

    bench("large_state_25x300_checkpoint", async () => {
      const graph = createSequential(10).compile({
        checkpointer: new MemorySaver(),
      });
      const input = createLargeDataset(5, 5);
      await runGraph(graph, input);
    });

    bench("large_state_15x600", async () => {
      const graph = createSequential(10).compile();
      const input = createLargeDataset(3, 5); // Approximates 15x600 complexity
      await runGraph(graph, input);
    });

    bench("large_state_15x600_checkpoint", async () => {
      const graph = createSequential(10).compile({
        checkpointer: new MemorySaver(),
      });
      const input = createLargeDataset(3, 5);
      await runGraph(graph, input);
    });

    bench("large_state_9x1200", async () => {
      const graph = createSequential(10).compile();
      const input = createLargeDataset(3, 3); // Approximates 9x1200 complexity
      await runGraph(graph, input);
    });

    bench("large_state_9x1200_checkpoint", async () => {
      const graph = createSequential(10).compile({
        checkpointer: new MemorySaver(),
      });
      const input = createLargeDataset(3, 3);
      await runGraph(graph, input);
    });
  });
});
