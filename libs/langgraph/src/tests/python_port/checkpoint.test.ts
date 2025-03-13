import { describe, it, expect } from "@jest/globals";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointTuple,
  CheckpointMetadata,
  ChannelVersions,
  MemorySaver,
} from "@langchain/langgraph-checkpoint";
import { RunnableConfig } from "@langchain/core/runnables";
import { StateGraph } from "../../graph/state.js";
import { Annotation, Command, END, Graph, Send, START } from "../../index.js";
import { gatherIterator } from "../../utils.js";
import { interrupt } from "../../interrupt.js";

class LongPutCheckpointer extends MemorySaver {
  constructor(private logs: string[], private delayMsec: number = 100) {
    super();
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    this.logs.push("checkpoint.aput.start");
    try {
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, this.delayMsec);
      });
      return super.put(config, checkpoint, metadata);
    } finally {
      this.logs.push("checkpoint.aput.end");
    }
  }
}

describe("Checkpoint Tests (Python port)", () => {
  /**
   * Port of test_checkpoint_errors from test_pregel_async_checkpoint.py
   */
  it("should handle various checkpoint errors", async () => {
    // Create a faulty get checkpoint saver
    class FaultyGetCheckpointer extends BaseCheckpointSaver {
      async getTuple(
        _config: RunnableConfig
      ): Promise<CheckpointTuple | undefined> {
        throw new Error("Faulty get_tuple");
      }

      async *list() {
        yield* [];
      }

      async put(
        _config: RunnableConfig,
        _checkpoint: Checkpoint,
        _metadata: CheckpointMetadata,
        _newVersions: ChannelVersions
      ): Promise<RunnableConfig> {
        return {};
      }

      async putWrites(
        _config: RunnableConfig,
        _writes: [string, unknown][],
        _taskId: string
      ): Promise<void> {
        // No explicit return needed
      }
    }

    // Create a faulty put checkpoint saver
    class FaultyPutCheckpointer extends BaseCheckpointSaver {
      async getTuple(
        _config: RunnableConfig
      ): Promise<CheckpointTuple | undefined> {
        return undefined;
      }

      async *list() {
        yield* [];
      }

      async put(
        _config: RunnableConfig,
        _checkpoint: Checkpoint,
        _metadata: CheckpointMetadata,
        _newVersions: ChannelVersions
      ): Promise<RunnableConfig> {
        throw new Error("Faulty put");
      }

      async putWrites(
        _config: RunnableConfig,
        _writes: [string, unknown][],
        _taskId: string
      ): Promise<void> {
        // No explicit return needed
      }
    }

    // Create a faulty putWrites checkpoint saver
    class FaultyPutWritesCheckpointer extends BaseCheckpointSaver {
      async getTuple(
        _config: RunnableConfig
      ): Promise<CheckpointTuple | undefined> {
        return undefined;
      }

      async *list() {
        yield* [];
      }

      async put(
        _config: RunnableConfig,
        _checkpoint: Checkpoint,
        _metadata: CheckpointMetadata,
        _newVersions: ChannelVersions
      ): Promise<RunnableConfig> {
        return {};
      }

      async putWrites(
        _config: RunnableConfig,
        _writes: [string, unknown][],
        _taskId: string
      ): Promise<void> {
        throw new Error("Faulty put_writes");
      }
    }

    // Create a faulty version checkpoint saver
    class FaultyVersionCheckpointer extends BaseCheckpointSaver<number> {
      getNextVersion(_current: number | undefined, _channel: unknown): number {
        throw new Error("Faulty get_next_version");
      }

      async getTuple(
        _config: RunnableConfig
      ): Promise<CheckpointTuple | undefined> {
        return undefined;
      }

      async *list() {
        yield* [];
      }

      async put(
        _config: RunnableConfig,
        _checkpoint: Checkpoint,
        _metadata: CheckpointMetadata,
        _newVersions: ChannelVersions
      ): Promise<RunnableConfig> {
        return {};
      }

      async putWrites(
        _config: RunnableConfig,
        _writes: [string, unknown][],
        _taskId: string
      ): Promise<void> {
        // No explicit return needed
      }
    }

    const StateAnnotation = Annotation.Root({
      value: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
      }),
    });

    // Simple node logic
    const logic = (): typeof StateAnnotation.Update => {
      return { value: "" };
    };

    // Create a graph builder with one node
    const builder = new StateGraph<
      typeof StateAnnotation.spec,
      typeof StateAnnotation.State,
      typeof StateAnnotation.Update,
      string
    >({
      stateSchema: StateAnnotation,
    })
      .addNode("agent", logic)
      .addEdge(START, "agent");

    // Test FaultyGetCheckpointer
    const graph1 = builder.compile({
      checkpointer: new FaultyGetCheckpointer(),
    });
    await expect(
      graph1.invoke({ value: "" }, { configurable: { thread_id: "thread-1" } })
    ).rejects.toThrow("Faulty get_tuple");

    await expect(async () => {
      await gatherIterator(
        await graph1.stream(
          { value: "" },
          { configurable: { thread_id: "thread-2" } }
        )
      );
    }).rejects.toThrow("Faulty get_tuple");

    await expect(async () => {
      await gatherIterator(
        await graph1.streamEvents(
          { value: "" },
          { configurable: { thread_id: "thread-3" }, version: "v2" }
        )
      );
    }).rejects.toThrow("Faulty get_tuple");

    // Test FaultyPutCheckpointer
    const graph2 = builder.compile({
      checkpointer: new FaultyPutCheckpointer(),
    });

    await expect(
      graph2.invoke({ value: "" }, { configurable: { thread_id: "thread-1" } })
    ).rejects.toThrow("Faulty put");

    await expect(async () => {
      await gatherIterator(
        await graph2.stream(
          { value: "" },
          { configurable: { thread_id: "thread-2" } }
        )
      );
    }).rejects.toThrow("Faulty put");

    await expect(async () => {
      await gatherIterator(
        await graph2.streamEvents(
          { value: "" },
          { configurable: { thread_id: "thread-3" }, version: "v2" }
        )
      );
    }).rejects.toThrow("Faulty put");

    // Test FaultyVersionCheckpointer
    const graph3 = builder.compile({
      checkpointer: new FaultyVersionCheckpointer(),
    });

    await expect(
      graph3.invoke({ value: "" }, { configurable: { thread_id: "thread-1" } })
    ).rejects.toThrow("Faulty get_next_version");

    await expect(async () => {
      await gatherIterator(
        await graph3.stream(
          { value: "" },
          { configurable: { thread_id: "thread-2" } }
        )
      );
    }).rejects.toThrow("Faulty get_next_version");

    await expect(async () => {
      await gatherIterator(
        await graph3.streamEvents(
          { value: "" },
          { configurable: { thread_id: "thread-3" }, version: "v2" }
        )
      );
    }).rejects.toThrow("Faulty get_next_version");

    const parallelBuilder = new StateGraph<
      typeof StateAnnotation.spec,
      typeof StateAnnotation.State,
      typeof StateAnnotation.Update,
      string
    >({
      stateSchema: StateAnnotation,
    })
      .addNode("agent", logic)
      .addNode("parallel", logic)
      .addEdge(START, "agent")
      .addEdge(START, "parallel");

    const graph4 = parallelBuilder.compile({
      checkpointer: new FaultyPutWritesCheckpointer(),
    });

    await expect(
      graph4.invoke({ value: "" }, { configurable: { thread_id: "thread-1" } })
    ).rejects.toThrow("Faulty put_writes");

    await expect(async () => {
      await gatherIterator(
        await graph4.stream(
          { value: "" },
          { configurable: { thread_id: "thread-2" } }
        )
      );
    }).rejects.toThrow("Faulty put_writes");

    await expect(async () => {
      await gatherIterator(
        await graph4.streamEvents(
          { value: "" },
          { configurable: { thread_id: "thread-3" }, version: "v2" }
        )
      );
    }).rejects.toThrow("Faulty put_writes");
  });

  it("should not cancel checkpoint put operation when invoke is cancelled", async () => {
    const logs: string[] = [];

    let innerTaskCancelled = false;

    // Node function that sleeps for 1 second
    async function awhile(
      _input: unknown,
      config?: RunnableConfig
    ): Promise<void> {
      logs.push("awhile.start");
      try {
        await new Promise<void>((resolve, reject) => {
          const timeoutId = setTimeout(() => resolve(), 1000);

          // Set up abort handling
          const signal = config?.signal;
          if (signal) {
            if (signal.aborted) {
              clearTimeout(timeoutId);
              reject(new Error("AbortError"));
              return;
            }

            const abortHandler = () => {
              clearTimeout(timeoutId);
              reject(new Error("AbortError"));
            };

            signal.addEventListener("abort", abortHandler, { once: true });

            // Clean up event listener if resolved normally
            setTimeout(() => {
              signal.removeEventListener("abort", abortHandler);
            }, 1000);
          }
        });
      } catch (e) {
        if (
          typeof e === "object" &&
          e !== null &&
          "message" in e &&
          e.message === "AbortError"
        ) {
          innerTaskCancelled = true;
          throw e;
        }
        throw e;
      } finally {
        logs.push("awhile.end");
      }
    }

    // Create a graph with one node
    const builder = new Graph()
      .addNode("agent", awhile)
      .addEdge(START, "agent")
      .addEdge("agent", END);

    const graph = builder.compile({
      checkpointer: new LongPutCheckpointer(logs),
    });

    const thread1 = { configurable: { thread_id: "1" } };

    // Create an AbortController to cancel the operation
    const controller = new AbortController();
    const { signal } = controller;

    // Start the task
    const invokePromise = graph.invoke(1, { ...thread1, signal });

    // Cancel after 50ms
    const cancelPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        controller.abort();
        resolve();
      }, 50);
    });

    // Wait a bit to ensure checkpoint.put has been called at least once
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 20);
    });

    // Check logs before cancellation is handled
    expect(logs).toContain("awhile.start");
    expect(logs).toContain("checkpoint.aput.start");

    await cancelPromise;

    // Wait for task to finish (should throw AbortError)
    await expect(invokePromise).rejects.toThrow();

    // Check logs after cancellation is handled
    expect(logs.sort()).toEqual([
      "awhile.end",
      "awhile.start",
      "checkpoint.aput.end",
      "checkpoint.aput.start",
    ]);

    // Verify task was cancelled
    expect(innerTaskCancelled).toBe(true);
  });

  /**
   * Port of test_checkpoint_put_after_cancellation_stream_anext from test_pregel_async_checkpoint.py
   */
  it("should not cancel checkpoint put operation when streaming is cancelled", async () => {
    const logs: string[] = [];

    let innerTaskCancelled = false;

    // Node function that sleeps for 1 second
    async function awhile(
      _input: unknown,
      config?: RunnableConfig
    ): Promise<void> {
      logs.push("awhile.start");
      try {
        await new Promise<void>((resolve, reject) => {
          const timeoutId = setTimeout(() => resolve(), 1000);

          // Set up abort handling
          const signal = config?.signal;
          if (signal) {
            if (signal.aborted) {
              clearTimeout(timeoutId);
              reject(new Error("AbortError"));
              return;
            }

            const abortHandler = () => {
              clearTimeout(timeoutId);
              reject(new Error("AbortError"));
            };

            signal.addEventListener("abort", abortHandler, { once: true });

            // Clean up event listener if resolved normally
            setTimeout(() => {
              signal.removeEventListener("abort", abortHandler);
            }, 1000);
          }
        });
      } catch (e) {
        if (
          typeof e === "object" &&
          e !== null &&
          "message" in e &&
          e.message === "AbortError"
        ) {
          innerTaskCancelled = true;
          throw e;
        }
        throw e;
      } finally {
        logs.push("awhile.end");
      }
    }

    // Create a graph with one node
    const builder = new Graph()
      .addNode("agent", awhile)
      .addEdge(START, "agent")
      .addEdge("agent", END);

    const graph = builder.compile({
      checkpointer: new LongPutCheckpointer(logs),
    });

    const thread1 = { configurable: { thread_id: "1" } };

    // Create an AbortController to cancel the operation
    const controller = new AbortController();
    const { signal } = controller;

    // Start the streaming
    const stream = graph.stream(1, {
      ...thread1,
      signal,
    });

    // Cancel after 50ms
    const cancelPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        controller.abort();
        resolve();
      }, 50);
    });

    // Wait a bit to ensure checkpoint.put has been called at least once
    // But not enough to complete cancellation process
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(logs).toContain("awhile.start");
    expect(logs).toContain("checkpoint.aput.start");

    await cancelPromise;

    // Wait for task to finish (should throw AbortError)
    await expect(async () => await gatherIterator(stream)).rejects.toThrow(
      "Abort"
    );

    // Check logs after cancellation is handled
    expect(logs.sort()).toEqual([
      "awhile.end",
      "awhile.start",
      "checkpoint.aput.end",
      "checkpoint.aput.start",
    ]);

    // Verify task was cancelled
    expect(innerTaskCancelled).toBe(true);
  });

  /**
   * Port of test_checkpoint_put_after_cancellation_stream_events_anext from test_pregel_async_checkpoint.py
   */
  it("should not cancel checkpoint put operation when streamEvents is cancelled", async () => {
    const logs: string[] = [];

    class LongPutCheckpointer extends MemorySaver {
      async put(
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata
      ): Promise<RunnableConfig> {
        logs.push("checkpoint.aput.start");
        try {
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              resolve();
            }, 1000);
          });
          return await super.put(config, checkpoint, metadata);
        } finally {
          logs.push("checkpoint.aput.end");
        }
      }
    }

    let innerTaskCancelled = false;

    // Node function that sleeps for 1 second
    async function awhile(
      _input: unknown,
      config?: RunnableConfig
    ): Promise<void> {
      logs.push("awhile.start");
      try {
        await new Promise<void>((resolve, reject) => {
          const timeoutId = setTimeout(() => resolve(), 1000);

          // Set up abort handling
          const signal = config?.signal;
          if (signal) {
            if (signal.aborted) {
              clearTimeout(timeoutId);
              reject(new Error("AbortError"));
              return;
            }

            const abortHandler = () => {
              clearTimeout(timeoutId);
              reject(new Error("AbortError"));
            };

            signal.addEventListener("abort", abortHandler, { once: true });

            // Clean up event listener if resolved normally
            setTimeout(() => {
              signal.removeEventListener("abort", abortHandler);
            }, 1000);
          }
        });
      } catch (e) {
        if (
          typeof e === "object" &&
          e !== null &&
          "message" in e &&
          e.message === "AbortError"
        ) {
          innerTaskCancelled = true;
          throw e;
        }
        throw e;
      } finally {
        logs.push("awhile.end");
      }
    }

    // Create a graph with one node
    const builder = new Graph()
      .addNode("agent", awhile)
      .addEdge(START, "agent")
      .addEdge("agent", END);

    const graph = builder.compile({
      checkpointer: new LongPutCheckpointer(),
    });

    const thread1 = { configurable: { thread_id: "1" } };

    const controller = new AbortController();
    const { signal } = controller;

    // Start the streaming events
    const streamEvents = graph.streamEvents(1, {
      ...thread1,
      version: "v2",
      signal,
    });

    // Cancel after 50ms
    const cancelPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        controller.abort();
        resolve();
      }, 50);
    });

    // Wait a bit to ensure checkpoint.put has been called at least once
    // But not enough to complete cancellation process
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });

    // Check logs before cancellation is fully handled
    expect(logs).toContain("checkpoint.aput.start");
    expect(logs).toContain("awhile.start");
    expect(logs.length).toBe(2);

    await cancelPromise;

    // Wait for task to finish (should throw AbortError)
    await expect(
      async () => await gatherIterator(streamEvents)
    ).rejects.toThrow("Abort");

    // Check logs after cancellation is handled
    expect(logs.sort()).toEqual([
      "awhile.end",
      "awhile.start",
      "checkpoint.aput.end",
      "checkpoint.aput.start",
    ]);

    // Verify the task was cancelled
    expect(innerTaskCancelled).toBe(true);
  });

  /**
   * Port of test_copy_checkpoint from test_pregel_async_checkpoint.py
   */
  it("should test copy checkpoint functionality", async () => {
    // We'll use MemorySaver directly since we don't have parametrize in Jest
    const checkpointer = new MemorySaver();

    // Define the state structure using Annotation

    // Define the state annotation
    const StateAnnotation = Annotation.Root({
      my_key: Annotation<string>({
        reducer: (a, b) => a + b,
        default: () => "",
      }),
      market: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
      }),
    });

    // Track tool_two_node invocation count
    let tool_two_node_count = 0;

    // Define tool_one node function
    const tool_one = (): typeof StateAnnotation.Update => {
      return { my_key: " one" };
    };

    // Define tool_two_node function with interrupt
    const tool_two_node = (
      state: typeof StateAnnotation.State
    ): typeof StateAnnotation.Update => {
      tool_two_node_count += 1;
      let answer;
      if (state.market === "DE") {
        answer = interrupt("Just because...");
      } else {
        answer = " all good";
      }
      return { my_key: answer };
    };

    // Define conditional entry point function
    const start = (state: typeof StateAnnotation.State): (Send | string)[] => {
      return ["tool_two", new Send("tool_one", state)];
    };

    // Create the graph
    const tool_two_graph = new StateGraph({
      stateSchema: StateAnnotation,
    })
      .addNode("tool_two", tool_two_node, {
        retryPolicy: { maxAttempts: 2 },
      })
      .addNode("tool_one", tool_one);

    tool_two_graph.addConditionalEdges(START, start);

    // Compile the graph without a checkpointer first
    const tool_two = tool_two_graph.compile();

    // Test basic invoke functionality
    const result1 = await tool_two.invoke({
      my_key: "value",
      market: "DE",
    });

    expect(result1).toEqual({
      my_key: "value one",
      market: "DE",
    });

    expect(tool_two_node_count).toBe(1);

    // Test with a different market value
    const result2 = await tool_two.invoke({
      my_key: "value",
      market: "US",
    });

    expect(result2).toEqual({
      my_key: "value all good one",
      market: "US",
    });

    // Now compile the graph with a checkpointer
    const tool_two_with_checkpoint = tool_two_graph.compile({
      checkpointer,
    });

    // Test missing thread_id error
    await expect(
      tool_two_with_checkpoint.invoke({
        my_key: "value",
        market: "DE",
      })
    ).rejects.toThrow("thread_id");

    // Test interrupt flow with resuming
    const thread2 = { configurable: { thread_id: "2" } };

    // Stream execution will be interrupted
    const stream1 = await tool_two_with_checkpoint.stream(
      {
        my_key: "value ⛰️",
        market: "DE",
      },
      thread2
    );

    const results1 = await gatherIterator(stream1);

    // Assert that we got the expected outputs including an interrupt
    expect(results1).toEqual([
      {
        tool_one: { my_key: " one" },
      },
      {
        __interrupt__: [
          expect.objectContaining({
            value: "Just because...",
            resumable: true,
            ns: expect.any(Array),
            when: "during",
          }),
        ],
      },
    ]);

    // Resume with an answer
    const stream2 = await tool_two_with_checkpoint.stream(
      new Command({ resume: " my answer" }),
      thread2
    );

    const results2 = await gatherIterator(stream2);

    // Assert that we get the cached output from tool_one and the new output from tool_two
    expect(results2).toEqual([
      {
        tool_one: { my_key: " one" },
        __metadata__: { cached: true },
      },
      {
        tool_two: { my_key: " my answer" },
      },
    ]);

    // Test interrupt flow with state updating
    const thread1 = { configurable: { thread_id: "1" } };

    // Invoke with DE market (will cause interrupt)
    const result3 = await tool_two_with_checkpoint.invoke(
      {
        my_key: "value ⛰️",
        market: "DE",
      },
      thread1
    );

    expect(result3).toEqual({
      my_key: "value ⛰️ one",
      market: "DE",
    });

    // Check the state
    const state = await tool_two_with_checkpoint.getState(thread1);

    // Just check partial state since the structure might vary
    expect(state.values).toEqual({
      my_key: "value ⛰️",
      market: "DE",
    });

    // Check for an interrupted task
    expect(
      state.tasks.some(
        (task) =>
          task.name === "tool_two" &&
          task.interrupts &&
          task.interrupts.length > 0 &&
          task.interrupts[0].value === "Just because..." &&
          task.interrupts[0].resumable === true
      )
    ).toBe(true);

    // Update state to clear the interrupt
    await tool_two_with_checkpoint.updateState(thread1, null, "__copy__");

    // Check updated state
    const updatedState = await tool_two_with_checkpoint.getState(thread1);

    // Check values were preserved
    expect(updatedState.values).toEqual({
      my_key: "value ⛰️",
      market: "DE",
    });

    // Check that the tool_two task no longer has interrupts
    const toolTwoTask = updatedState.tasks.find(
      (task) => task.name === "tool_two"
    );
    expect(toolTwoTask).toBeDefined();
    expect(toolTwoTask?.interrupts).toEqual([]);
  });
});
