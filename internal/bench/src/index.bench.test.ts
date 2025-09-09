import { bench, describe } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { createSequential } from "./sequential.js";
import { reactAgent } from "./react_agent.js";
import { runGraph, runFirstEventLatency } from "./utils.js";

// Sequential benchmarks
describe("sequential_10", () => {
  bench("sequential_10", async () => {
    const graph = createSequential(10).compile();
    await runGraph(graph, { messages: [] });
  });

  bench("sequential_10_checkpoint", async () => {
    const graph = createSequential(10).compile({
      checkpointer: new MemorySaver(),
    });
    await runGraph(graph, { messages: [] });
  });
});

describe("sequential_1000", () => {
  bench("sequential_1000", async () => {
    const graph = createSequential(1000).compile();
    await runGraph(graph, { messages: [] });
  });

  bench("sequential_1000_checkpoint", async () => {
    const graph = createSequential(1000).compile({
      checkpointer: new MemorySaver(),
    });
    await runGraph(graph, { messages: [] });
  });
});

// React Agent benchmarks
describe("react_agent_10x", () => {
  bench("react_agent_10x", async () => {
    const graph = reactAgent(10);
    await runGraph(graph, { messages: [new HumanMessage("hi?")] });
  });

  bench("react_agent_10x_checkpoint", async () => {
    const graph = reactAgent(10, new MemorySaver());
    await runGraph(graph, { messages: [new HumanMessage("hi?")] });
  });
});

describe("react_agent_100x", () => {
  bench("react_agent_100x", async () => {
    const graph = reactAgent(100);
    await runGraph(graph, { messages: [new HumanMessage("hi?")] });
  });

  bench("react_agent_100x_checkpoint", async () => {
    const graph = reactAgent(100, new MemorySaver());
    await runGraph(graph, { messages: [new HumanMessage("hi?")] });
  });
});

// First event latency benchmarks (subset)
describe("First Event Latency", () => {
  bench("sequential_1000_first_event_latency", async () => {
    const graph = createSequential(1000).compile();
    await runFirstEventLatency(graph, { messages: [] });
  });

  bench("sequential_1000_first_event_latency_checkpoint", async () => {
    const graph = createSequential(1000).compile({
      checkpointer: new MemorySaver(),
    });
    await runFirstEventLatency(graph, { messages: [] });
  });
});

// Graph compilation benchmarks
describe("Graph Compilation", () => {
  bench("sequential_1000_compilation", () => {
    createSequential(1000).compile();
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
