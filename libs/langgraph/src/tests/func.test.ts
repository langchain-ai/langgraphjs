import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { describe, it, expect } from "@jest/globals";
import { task, entrypoint } from "../func.js";
import { initializeAsyncLocalStorageSingleton } from "../setup/async_local_storage.js";

describe("task and entrypoint decorators", () => {
  beforeAll(() => {
    initializeAsyncLocalStorageSingleton();
  });
  it("basic task and entrypoint", async () => {
    const checkpointer = new MemorySaver();
    let mapperCallCount = 0;

    // Define a simple mapper task
    const mapper = task("mapper", (input: number) => {
      mapperCallCount += 1;
      return `${input}${input}`;
    });

    let entrypointCallCount = 0;

    // Create a graph using entrypoint
    const graph = entrypoint(
      { checkpointer, name: "graph" },
      async (inputs: number[]) => {
        entrypointCallCount += 1;
        return Promise.all(inputs.map((i) => mapper(i)));
      }
    );

    // Test the graph
    const result = await graph.invoke([[1, 2, 3]], {
      configurable: { thread_id: "1" },
    });

    expect(result).toEqual(["11", "22", "33"]);
    expect(mapperCallCount).toEqual(3);
    expect(entrypointCallCount).toEqual(1);
  });
});
