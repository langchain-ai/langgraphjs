import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { describe, it, expect, beforeAll } from "@jest/globals";
import { task, entrypoint } from "../func.js";
import { initializeAsyncLocalStorageSingleton } from "../setup/async_local_storage.js";
import { Command } from "../constants.js";
import { interrupt } from "../interrupt.js";

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

    // Test the graph - pass array of inputs as first argument
    const result = await graph.invoke([[1, 2, 3]], {
      configurable: { thread_id: "1" },
    });

    expect(result).toEqual(["11", "22", "33"]);
    expect(mapperCallCount).toBe(3);
    expect(entrypointCallCount).toBe(1);
  });

  it("multiple tasks with different timings", async () => {
    const checkpointer = new MemorySaver();
    const delay = 10; // 10ms delay

    const slowMapper = task("slowMapper", async (input: number) => {
      // eslint-disable-next-line no-promise-executor-return
      await new Promise((resolve) => setTimeout(resolve, delay * input));
      return `${input}${input}`;
    });

    const graph = entrypoint(
      { checkpointer, name: "parallelGraph" },
      async (inputs: number[]) => {
        const startTime = Date.now();
        const results = await Promise.all(inputs.map((i) => slowMapper(i)));
        const endTime = Date.now();

        // The total time should be close to the longest task's time
        // We add some buffer for test stability
        expect(endTime - startTime).toBeLessThan(
          delay * Math.max(...inputs) * 1.5
        );

        return results;
      }
    );

    const result = await graph.invoke([[1, 2, 3]], {
      configurable: { thread_id: "1" },
    });

    expect(result).toEqual(["11", "22", "33"]);
  });

  it("task with interrupts", async () => {
    const checkpointer = new MemorySaver();
    let taskCallCount = 0;

    const interruptingTask = task("interruptTask", async () => {
      taskCallCount += 1;
      return (await interrupt("Please provide input")) as string;
    });

    let graphCallCount = 0;
    const graph = entrypoint(
      { checkpointer, name: "interruptGraph" },
      async (input: string) => {
        graphCallCount += 1;
        const response = await interruptingTask();
        return input + response;
      }
    );

    const config = { configurable: { thread_id: "test-thread" } };

    // First run should interrupt - pass single argument as array
    const firstRun = await graph.invoke(["the correct "], config);
    expect(firstRun).toBeUndefined();
    expect(taskCallCount).toBe(1);
    expect(graphCallCount).toBe(1);

    let currTasks = (await graph.getState(config)).tasks;
    expect(currTasks[0].interrupts).toHaveLength(1);

    // Resume with answer
    const result = await graph.invoke(
      new Command({ resume: "answer" }),
      config
    );

    currTasks = (await graph.getState(config)).tasks;
    expect(currTasks.length).toBe(0);

    expect(result).toBe("the correct answer");
    expect(taskCallCount).toBe(2);
    expect(graphCallCount).toBe(2);
  });

  it("task with retry policy", async () => {
    const checkpointer = new MemorySaver();
    let attempts = 0;

    const failingTask = task(
      "failingTask",
      () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("Task failed");
        }
        return "success";
      },
      { retry: { maxAttempts: 3 } }
    );

    const graph = entrypoint({ checkpointer, name: "retryGraph" }, async () =>
      failingTask()
    );

    const result = await graph.invoke([], {
      configurable: { thread_id: "1" },
    });

    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  it("nested tasks and subgraphs", async () => {
    const checkpointer = new MemorySaver();

    // Define addition subgraph
    const add = entrypoint({ name: "add" }, async (a: number, b: number) => {
      return a + b;
    });

    // Define multiplication subgraph using tasks
    const multiply = task("multiply", async (a: number, b: number) => {
      return a * b;
    });

    // Test calling multiple operations
    const combinedOps = task("combinedOps", async (a: number, b: number) => {
      const sum = await add.invoke([a, b]);
      const product = await multiply(a, b);
      return [sum, product];
    });

    const graph = entrypoint(
      { checkpointer, name: "nestedGraph" },
      async (a: number, b: number) => {
        return combinedOps(a, b);
      }
    );

    const result = await graph.invoke([2, 3], {
      configurable: { thread_id: "1" },
    });

    expect(result).toEqual([5, 6]);
  });

  it("should stream results", async () => {
    const timeDelay = 10; // 10ms delay

    const slowTask = task("slowTask", async () => {
      // eslint-disable-next-line no-promise-executor-return
      await new Promise((resolve) => setTimeout(resolve, timeDelay));
      return { timestamp: Date.now() };
    });

    const graph = entrypoint({ name: "streamGraph" }, async () => {
      const first = await slowTask();
      const second = await slowTask();
      return [first, second];
    });

    const arrivalTimes: number[] = [];

    // Using for-await to process the stream - pass empty array since no args needed
    for await (const chunk of await graph.stream([])) {
      const now = Date.now();
      if ("slowTask" in chunk) {
        arrivalTimes.push(now);
      }
    }

    expect(arrivalTimes.length).toBe(2);
    const timeDiff = arrivalTimes[1] - arrivalTimes[0];
    // Time difference should be at least the delay
    expect(timeDiff).toBeGreaterThanOrEqual(timeDelay);
  });
});
