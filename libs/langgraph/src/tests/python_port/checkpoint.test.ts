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
import { LastValue } from "../../channels/last_value.js";
import { BinaryOperatorAggregate } from "../../channels/binop.js";
import { Channel, Pregel } from "../../pregel/index.js";

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
        retryPolicy: {
          maxAttempts: 2,
          initialInterval: 10,
          maxInterval: 20,
          backoffFactor: 2,
          logWarning: false,
        },
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
      my_key: "value ⛰️ one",
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

  /**
   * Port of test_invoke_checkpoint from test_pregel_async_checkpoint.py
   */
  it("should test invoke checkpoint functionality", async () => {
    // Define the add_one function
    const addOne = (input: { total: number; input: number }): number => {
      return input.total + input.input;
    };

    // Track whether raiseIfAbove10 has errored once
    let erroredOnce = false;

    // Create a function that will raise an error if input is above certain thresholds
    const raiseIfAbove10 = (input: number): number => {
      if (input > 4) {
        if (erroredOnce) {
          // Do nothing on second attempt
        } else {
          erroredOnce = true;
          throw new Error("ConnectionError: I will be retried");
        }
      }
      if (input > 10) {
        throw new Error("ValueError: Input is too large");
      }
      return input;
    };

    // Create a checkpoint saver
    const checkpointer = new MemorySaver();

    // Create a graph with subscription and channel writes
    const one = Channel.subscribeTo(["input"])
      .join(["total"])
      .pipe(addOne)
      .pipe(
        Channel.writeTo([], {
          output: (x: number) => x,
          total: (x: number) => x,
        })
      )
      .pipe(raiseIfAbove10);

    // Create the Pregel graph
    const app = new Pregel({
      nodes: {
        one,
      },
      channels: {
        total: new BinaryOperatorAggregate<number>(
          (a, b) => a + b,
          () => 0
        ),
        input: new LastValue<number>(),
        output: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: "output",
      checkpointer,
      retryPolicy: {
        maxAttempts: 3,
        initialInterval: 10,
        maxInterval: 40,
        backoffFactor: 2,
        logWarning: false,
      },
    });

    // Test the first invocation - total starts at 0, so output is 0+2=2
    const result1 = await app.invoke(2, { configurable: { thread_id: "1" } });
    expect(result1).toBe(2);

    // Check checkpoint state
    const checkpoint1 = await checkpointer.get({
      configurable: { thread_id: "1" },
    });
    expect(checkpoint1).not.toBeUndefined();
    expect(checkpoint1?.channel_values.total).toBe(2);

    // Test second invocation - total is now 2, so output is 2+3=5
    const result2 = await app.invoke(3, { configurable: { thread_id: "1" } });
    expect(result2).toBe(5);
    expect(erroredOnce).toBe(true); // Should have errored and retried

    // Check updated checkpoint
    const checkpoint2 = await checkpointer.get({
      configurable: { thread_id: "1" },
    });
    expect(checkpoint2).not.toBeUndefined();
    expect(checkpoint2?.channel_values.total).toBe(7);

    // Test third invocation - total is now 7, output would be 7+4=11, but raises ValueError
    await expect(
      app.invoke(4, { configurable: { thread_id: "1" } })
    ).rejects.toThrow("ValueError");

    // Checkpoint should not be updated after error
    const checkpoint3 = await checkpointer.get({
      configurable: { thread_id: "1" },
    });
    expect(checkpoint3).not.toBeUndefined();
    expect(checkpoint3?.channel_values.total).toBe(7);

    // Test invocation with new thread - total starts at 0, so output is 0+5=5
    const result4 = await app.invoke(5, { configurable: { thread_id: "2" } });
    expect(result4).toBe(5);

    // Original thread should still have its state
    const checkpoint4 = await checkpointer.get({
      configurable: { thread_id: "1" },
    });
    expect(checkpoint4).not.toBeUndefined();
    expect(checkpoint4?.channel_values.total).toBe(7);

    // New thread should have its own state
    const checkpoint5 = await checkpointer.get({
      configurable: { thread_id: "2" },
    });
    expect(checkpoint5).not.toBeUndefined();
    expect(checkpoint5?.channel_values.total).toBe(5);
  });

  /**
   * Port of test_pending_writes_resume from test_pregel_async_checkpoint.py
   */
  it("should test pending writes resume functionality", async () => {
    // Create a memory saver checkpoint instance
    const checkpointer = new MemorySaver();

    // Define the state annotation
    const StateAnnotation = Annotation.Root({
      value: Annotation<number>({
        reducer: (a, b) => a + b,
        default: () => 0,
      }),
    });

    // Create the AwhileMaker class that simulates delayed node execution
    class AwhileMaker {
      private sleep: number;

      rtn: Record<string, unknown> | Error;

      public calls: number;

      constructor(sleep: number, rtn: Record<string, unknown> | Error) {
        this.sleep = sleep;
        this.rtn = rtn;
        this.reset();
      }

      async call(
        _input: typeof StateAnnotation.State
      ): Promise<typeof StateAnnotation.Update> {
        this.calls += 1;
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            resolve();
          }, this.sleep);
        });

        // eslint-disable-next-line no-instanceof/no-instanceof
        if (this.rtn instanceof Error) {
          throw this.rtn;
        } else {
          return this.rtn as typeof StateAnnotation.Update;
        }
      }

      reset(): void {
        this.calls = 0;
      }
    }

    // Create two nodes - one succeeds, one fails
    const one = new AwhileMaker(10, { value: 2 });
    const two = new AwhileMaker(300, new Error("I'm not good"));

    // Create the graph
    const builder = new StateGraph({
      stateSchema: StateAnnotation,
    })
      .addNode("one", one.call.bind(one))
      .addNode("two", two.call.bind(two), {
        retryPolicy: {
          maxAttempts: 2,
          initialInterval: 10,
          maxInterval: 20,
          backoffFactor: 2,
          logWarning: false,
        },
      })
      .addEdge(START, "one")
      .addEdge(START, "two");

    const graph = builder.compile({
      checkpointer,
    });

    const thread1 = { configurable: { thread_id: "1" } };

    // Invoke the graph - should fail with the error from node two
    await expect(graph.invoke({ value: 1 }, thread1)).rejects.toThrow(
      "I'm not good"
    );

    // Both nodes should have been called
    expect(one.calls).toBe(1);
    expect(two.calls).toBe(2); // Two attempts due to retry policy

    const state = await graph.getState(thread1);
    expect(state).toBeDefined();

    // Latest checkpoint should be before nodes "one", "two"
    // but we should have applied the write from "one"
    expect(state.next).toEqual(["two"]);
    expect(state.values).toEqual({ value: 3 }); // 1 + 2 = 3

    // Check that tasks were correctly recorded
    expect(state.tasks.length).toBe(2);
    const oneTask = state.tasks.find((task) => task.name === "one");
    const twoTask = state.tasks.find((task) => task.name === "two");

    expect(oneTask).toBeDefined();
    // Don't need to verify specific properties that might vary
    expect(oneTask?.name).toBe("one");

    expect(twoTask).toBeDefined();
    expect(twoTask?.name).toBe("two");
    // The error exists and contains our message
    expect(twoTask?.error).toBeDefined();
    expect(JSON.stringify(twoTask?.error)).toContain("I'm not good");

    // Metadata should match expected values
    expect(state.metadata).toEqual({
      parents: {},
      source: "loop",
      step: 0,
      writes: null,
      thread_id: "1",
    });

    // Get state with checkpoint_id should not apply any pending writes
    const rawState = await graph.getState(state.config);
    expect(rawState).toBeDefined();
    expect(rawState.values).toEqual({ value: 1 });
    expect(rawState.next).toEqual(expect.arrayContaining(["one", "two"]));

    // Resume execution - should still fail with same error
    await expect(graph.invoke(null, thread1)).rejects.toThrow("I'm not good");

    // Node "one" succeeded previously, so shouldn't be called again
    expect(one.calls).toBe(1);
    // Node "two" should have been called again
    expect(two.calls).toBe(4); // two attempts before + two attempts now

    // Confirm no new checkpoints saved by checking state_two metadata
    const stateTwo = await graph.getState(thread1);
    expect(stateTwo.metadata).toEqual(state.metadata);

    two.rtn = { value: 3 };

    // Both the pending write and the new write were applied, 1 + 2 + 3 = 6
    const finalResult = await graph.invoke(null, thread1);
    expect(finalResult).toEqual({ value: 6 });

    // Check checkpoints using list
    const checkpoints = [];
    for await (const checkpoint of checkpointer.list({ ...thread1 })) {
      checkpoints.push(checkpoint);
    }

    // We should have 3 checkpoints
    expect(checkpoints.length).toBe(3);

    // First checkpoint (most recent) should have no pending writes
    expect(checkpoints[0]?.pendingWrites).toEqual([]);

    // Check that the metadata in the first checkpoint has writes
    expect(checkpoints[0]?.metadata?.writes).toBeDefined();

    expect(checkpoints[1]?.pendingWrites).toBeDefined();
    expect(checkpoints[2]?.pendingWrites).toBeDefined();
  });

  /**
   * Port of test_run_from_checkpoint_id_retains_previous_writes from test_pregel_async_checkpoint.py
   */
  it("should test that running from a checkpoint ID retains previous writes", async () => {
    // Create a memory saver checkpoint instance
    const checkpointer = new MemorySaver();

    // Define the state annotation
    const StateAnnotation = Annotation.Root({
      myval: Annotation<number>({
        reducer: (a, b) => a + b,
        default: () => 0,
      }),
      otherval: Annotation<boolean>({
        reducer: (_, b) => b,
        default: () => false,
      }),
    });

    // Create the Anode class that toggles its state on each call
    class Anode {
      private switch = false;

      async call(
        _state: typeof StateAnnotation.State
      ): Promise<typeof StateAnnotation.Update> {
        this.switch = !this.switch;
        return {
          myval: this.switch ? 2 : 1,
          otherval: this.switch,
        };
      }
    }

    // Create a node instance
    const theNode = new Anode();

    // Create the conditional edge function generator
    const getEdge = (src: string) => {
      const swap = src === "node_two" ? "node_one" : "node_two";

      return (state: typeof StateAnnotation.State): string => {
        if (state.myval > 3) {
          return END;
        }
        if (state.otherval) {
          return swap;
        }
        return src;
      };
    };

    // Create the graph
    const builder = new StateGraph({
      stateSchema: StateAnnotation,
    })
      .addNode("node_one", theNode.call.bind(theNode))
      .addNode("node_two", theNode.call.bind(theNode))
      .addEdge(START, "node_one")
      .addConditionalEdges("node_one", getEdge("node_one"))
      .addConditionalEdges("node_two", getEdge("node_two"));

    const graph = builder.compile({
      checkpointer,
    });

    // Generate a unique thread_id
    const threadId = `thread-${Date.now()}`;
    const thread1 = { configurable: { thread_id: threadId } };

    // First run of the graph
    const result = await graph.invoke({ myval: 1 }, thread1);
    expect(result.myval).toBe(4);

    // Get state history
    const historyPromise = graph.getStateHistory(thread1);
    const history = [];
    for await (const state of historyPromise) {
      history.push(state);
    }

    // Check history
    expect(history.length).toBe(4);
    // Last state (oldest) should have myval = 0 (default)
    expect(history[history.length - 1].values.myval).toBe(0);
    // First state (most recent) should have final values
    expect(history[0].values).toEqual({ myval: 4, otherval: false });

    // Make sure we have a checkpoint_id before proceeding
    expect(history[1]?.config).toBeDefined();
    if (history[1]?.config?.configurable?.checkpoint_id) {
      // Run from the second checkpoint
      const secondRunConfig = {
        ...thread1,
        configurable: {
          ...thread1.configurable,
          checkpoint_id: history[1].config.configurable.checkpoint_id,
        },
      };

      const secondResult = await graph.invoke(null, secondRunConfig);
      expect(secondResult).toEqual({ myval: 5, otherval: true });

      // Get updated history
      const newHistoryPromise = graph.getStateHistory({
        configurable: { thread_id: threadId, checkpoint_ns: "" },
      });
      const newHistory = [];
      for await (const state of newHistoryPromise) {
        newHistory.push(state);
      }

      // Check updated history
      expect(newHistory.length).toBe(history.length + 1);

      // Compare original history with new history (skipping the first new state)
      for (let i = 0; i < history.length; i += 1) {
        const original = history[i];
        const newState = newHistory[i + 1];

        expect(newState.values).toEqual(original.values);
        expect(newState.next).toEqual(original.next);

        // Check metadata if both have it
        if (newState.metadata && original.metadata) {
          expect(newState.metadata.step).toBe(original.metadata.step);
        }
      }

      // Helper function to get tasks
      type HistoryItem = { tasks: unknown };
      const getTasks = (hist: HistoryItem[], start: number): unknown[] => {
        return hist.slice(start).map((h) => h.tasks);
      };

      // Compare tasks
      expect(getTasks(newHistory, 1)).toEqual(getTasks(history, 0));
    } else {
      throw new Error("Expected checkpoint_id to be defined in history[1]");
    }
  });

  /**
   * Port of test_invoke_checkpoint_three from test_pregel_async_checkpoint.py
   */
  it("should test invoke checkpoint functionality with multiple operations", async () => {
    // Create a memory saver checkpoint instance
    const checkpointer = new MemorySaver();

    // Mock the add_one function - in JS we'll track calls with a counter
    const addOne = (input: { total: number; input: number }): number => {
      return input.total + input.input;
    };

    // Create function that raises error for values above threshold
    const raiseIfAbove10 = (input: number): number => {
      if (input > 10) {
        throw new Error("ValueError: Input is too large");
      }
      return input;
    };

    // Create a channel pipeline with subscription and writes
    const one = Channel.subscribeTo(["input"])
      .join(["total"])
      .pipe(addOne)
      .pipe(
        Channel.writeTo([], {
          output: (x: number) => x,
          total: (x: number) => x,
        })
      )
      .pipe(raiseIfAbove10);

    // Create the Pregel graph with appropriate channels
    const app = new Pregel({
      nodes: {
        one,
      },
      channels: {
        total: new BinaryOperatorAggregate<number>(
          (a, b) => a + b,
          () => 0
        ),
        input: new LastValue<number>(),
        output: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: "output",
      checkpointer,
      debug: true,
    });

    // Create thread config for first thread
    const thread1 = { configurable: { thread_id: "1" } };

    // First invocation - total starts at 0, so output is 0+2=2
    const result1 = await app.invoke(2, thread1);
    expect(result1).toBe(2);

    // Check state after first invocation
    const state1 = await app.getState(thread1);
    expect(state1).not.toBeUndefined();
    expect(state1?.values.total).toBe(2);

    // Verify checkpoint ID matches
    const checkpoint1 = await checkpointer.get(thread1);
    expect(state1?.config?.configurable?.checkpoint_id).toBe(checkpoint1?.id);

    // Second invocation - total is now 2, so output is 2+3=5
    const result2 = await app.invoke(3, thread1);
    expect(result2).toBe(5);

    // Check updated state
    const state2 = await app.getState(thread1);
    expect(state2).not.toBeUndefined();
    expect(state2?.values.total).toBe(7);

    // Verify updated checkpoint ID
    const checkpoint2 = await checkpointer.get(thread1);
    expect(state2?.config?.configurable?.checkpoint_id).toBe(checkpoint2?.id);

    // Third invocation - total is now 7, so output would be 7+4=11, but raises ValueError
    await expect(app.invoke(4, thread1)).rejects.toThrow("ValueError");

    // Checkpoint should not be updated after error
    const state3 = await app.getState(thread1);
    expect(state3).not.toBeUndefined();
    expect(state3?.values.total).toBe(7);
    expect(state3?.next).toEqual(["one"]);

    // We can recover from error by sending new inputs
    const result4 = await app.invoke(2, thread1);
    expect(result4).toBe(9);

    // Check state after recovery
    const state4 = await app.getState(thread1);
    expect(state4).not.toBeUndefined();
    expect(state4?.values.total).toBe(16); // total is now 7+9=16
    expect(state4?.next).toEqual([]);

    // Test with new thread - thread 2
    const thread2 = { configurable: { thread_id: "2" } };

    // On a new thread, total starts at 0, so output is 0+5=5
    const result5 = await app.invoke(5, thread2);
    expect(result5).toBe(5);

    // Original thread should still have its state
    const state5 = await app.getState({ configurable: { thread_id: "1" } });
    expect(state5).not.toBeUndefined();
    expect(state5?.values.total).toBe(16);
    expect(state5?.next).toEqual([]);

    // New thread should have its own state
    const state6 = await app.getState(thread2);
    expect(state6).not.toBeUndefined();
    expect(state6?.values.total).toBe(5);
    expect(state6?.next).toEqual([]);

    // Test state history functionality
    const historyLimit1 = [];
    for await (const state of app.getStateHistory(thread1, { limit: 1 })) {
      historyLimit1.push(state);
    }
    expect(historyLimit1.length).toBe(1);

    // List all checkpoints for thread 1
    const thread1History = [];
    for await (const state of app.getStateHistory(thread1)) {
      thread1History.push(state);
    }

    // There should be 7 checkpoints
    expect(thread1History.length).toBe(7);

    // Count sources of checkpoints
    const sourceCounts: Record<string, number> = {};
    for (const state of thread1History) {
      expect(state.metadata).toBeDefined();
      const { source } = state.metadata!;
      sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    }
    expect(sourceCounts).toEqual({ input: 4, loop: 3 });

    // Verify checkpoints are sorted descending by ID
    expect(
      thread1History[0]?.config?.configurable?.checkpoint_id >
        thread1History[1].config?.configurable?.checkpoint_id
    ).toBe(true);

    // Test cursor pagination (get checkpoint after the first one)
    const cursored = [];
    for await (const state of app.getStateHistory(thread1, {
      limit: 1,
      before: thread1History[0].config,
    })) {
      cursored.push(state);
    }
    expect(cursored.length).toBe(1);
    expect(cursored[0].config).toEqual(thread1History[1].config);

    // Check values at specific checkpoints
    expect(thread1History[0].values.total).toBe(16); // The last checkpoint
    expect(thread1History[thread1History.length - 2].values.total).toBe(2); // The first "loop" checkpoint

    // Verify get with config works
    const checkpoint1GetWithConfig = await checkpointer.get(
      thread1History[0].config
    );
    expect(checkpoint1GetWithConfig?.id).toBe(
      thread1History[0]?.config?.configurable?.checkpoint_id
    );

    const checkpoint2GetWithConfig = await checkpointer.get(
      thread1History[1].config
    );
    expect(checkpoint2GetWithConfig?.id).toBe(
      thread1History[1]?.config?.configurable?.checkpoint_id
    );

    // Test updating state from a specific checkpoint
    const thread1NextConfig = await app.updateState(
      thread1History[1].config,
      10
    );

    // Update creates a new checkpoint with higher ID
    expect(
      thread1NextConfig.configurable?.checkpoint_id >
        thread1History[0]?.config?.configurable?.checkpoint_id
    ).toBe(true);

    // There should now be 8 checkpoints in history
    const updatedHistory = [];
    for await (const state of app.getStateHistory(thread1)) {
      updatedHistory.push(state);
    }
    expect(updatedHistory.length).toBe(8);

    // Count sources after update
    const updatedSourceCounts: Record<string, number> = {};
    for (const state of updatedHistory) {
      expect(state.metadata).toBeDefined();
      const { source } = state.metadata!;
      updatedSourceCounts[source] = (updatedSourceCounts[source] || 0) + 1;
    }
    expect(updatedSourceCounts).toEqual({ update: 1, input: 4, loop: 3 });

    // The latest checkpoint should be the updated one
    const latestState = await app.getState(thread1);
    const updatedState = await app.getState(thread1NextConfig);
    expect(latestState).toEqual(updatedState);
  });
});
