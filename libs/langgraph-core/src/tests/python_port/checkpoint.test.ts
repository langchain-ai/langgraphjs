import { describe, it, expect, beforeAll } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { RunnableConfig } from "@langchain/core/runnables";
import {
  AIMessage,
  HumanMessage,
  isAIMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointTuple,
  CheckpointMetadata,
  ChannelVersions,
  MemorySaver,
  BaseStore,
  InMemoryStore,
} from "@langchain/langgraph-checkpoint";
import { StateGraph } from "../../graph/state.js";
import {
  Annotation,
  Command,
  END,
  Graph,
  LangGraphRunnableConfig,
  Send,
  START,
} from "../../web.js";
import { gatherIterator } from "../../utils.js";
import { interrupt } from "../../interrupt.js";
import { LastValue } from "../../channels/last_value.js";
import { BinaryOperatorAggregate } from "../../channels/binop.js";
import { Channel, Pregel } from "../../pregel/index.js";
import { MessagesAnnotation } from "../../graph/messages_annotation.js";
import { ToolNode } from "../../prebuilt/index.js";
import { initializeAsyncLocalStorageSingleton } from "../../setup/async_local_storage.js";
import { FakeToolCallingChatModel } from "../utils.models.js";

class LongPutCheckpointer extends MemorySaver {
  logs: string[];

  delayMsec: number;

  constructor(logs: string[], delayMsec: number = 100) {
    super();
    this.logs = logs;
    this.delayMsec = delayMsec;
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    this.logs.push("putting checkpoint");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, this.delayMsec);
    });
    try {
      const result = await super.put(config, checkpoint, metadata);
      this.logs.push("put checkpoint");
      return result;
    } catch (err) {
      this.logs.push("error putting checkpoint");
      throw err;
    }
  }
}

/**
 * Custom checkpointer that verifies a run's configurable fields
 * are merged with the previous checkpoint config for each step
 */
class MemorySaverAssertCheckpointMetadata extends MemorySaver {
  /**
   * This implementation merges config["configurable"] (a run's configurable fields)
   * with the metadata field. The state of the checkpoint metadata can be asserted
   * to confirm that the run's configurable fields were merged.
   */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const configurable = { ...config.configurable };

    // Remove checkpoint_id to make testing simpler
    delete configurable.checkpoint_id;

    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns || "";

    // Make sure storage structure exists
    if (!this.storage[threadId]) {
      this.storage[threadId] = {};
    }
    if (!this.storage[threadId][checkpointNs]) {
      this.storage[threadId][checkpointNs] = {};
    }

    // Serialize checkpoint and merged metadata
    const serializedCheckpoint = (await this.serde.dumpsTyped(checkpoint))[1];
    const serializedMergedMetadata = (
      await this.serde.dumpsTyped({
        ...configurable,
        ...metadata,
      })
    )[1];

    // Store in the storage with merged metadata
    this.storage[threadId][checkpointNs][checkpoint.id] = [
      serializedCheckpoint,
      serializedMergedMetadata,
      config.configurable?.checkpoint_id,
    ];

    // Return updated config with checkpoint id
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_id: checkpoint.id,
      },
    };
  }
}

beforeAll(() => {
  // Will occur naturally if user imports from main `@langchain/langgraph` endpoint.
  initializeAsyncLocalStorageSingleton();
});

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

      deleteThread(_threadId: string): Promise<void> {
        throw new Error("Faulty delete_thread");
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

      deleteThread(_threadId: string): Promise<void> {
        throw new Error("Faulty delete_thread");
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

      deleteThread(_threadId: string): Promise<void> {
        throw new Error("Faulty delete_thread");
      }
    }

    // Create a faulty version checkpoint saver
    class FaultyVersionCheckpointer extends BaseCheckpointSaver<number> {
      getNextVersion(_current: number | undefined): number {
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

      deleteThread(_threadId: string): Promise<void> {
        throw new Error("Faulty delete_thread");
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
    expect(logs).toContain("putting checkpoint");

    await cancelPromise;

    // Wait for task to finish (should throw AbortError)
    await expect(invokePromise).rejects.toThrow();

    // Check logs after cancellation is handled
    expect(logs.sort()).toEqual([
      "awhile.end",
      "awhile.start",
      "put checkpoint",
      "putting checkpoint",
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
    expect(logs).toContain("putting checkpoint");

    await cancelPromise;

    // Wait for task to finish (should throw AbortError)
    await expect(async () => await gatherIterator(stream)).rejects.toThrow(
      "Abort"
    );

    // Check logs after cancellation is handled
    expect(logs.sort()).toEqual([
      "awhile.end",
      "awhile.start",
      "put checkpoint",
      "putting checkpoint",
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
    expect(logs).toContain("putting checkpoint");
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
      "put checkpoint",
      "putting checkpoint",
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

    // Test basic invoke functionality, should fail b/c of lack of checkpointer
    await expect(
      tool_two.invoke({
        my_key: "value",
        market: "DE",
      })
    ).rejects.toThrow(/No checkpointer set/);
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
      { my_key: "value ⛰️", market: "DE" },
      thread2
    );

    const results1 = await gatherIterator(stream1);

    // Assert that we got the expected outputs including an interrupt
    expect(results1).toEqual([
      {
        __interrupt__: [
          expect.objectContaining({
            id: expect.any(String),
            value: "Just because...",
          }),
        ],
      },
      { tool_one: { my_key: " one" } },
    ]);

    // check if the interrupt is persisted
    const state1 = await tool_two_with_checkpoint.getState(thread2);
    expect(state1.tasks.at(-1)?.interrupts).toEqual([
      {
        id: expect.any(String),
        value: "Just because...",
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
      __interrupt__: [
        {
          id: expect.any(String),
          value: "Just because...",
        },
      ],
    });

    // Check the state
    const state2 = await tool_two_with_checkpoint.getState(thread1);

    // Just check partial state since the structure might vary
    expect(state2.values).toEqual({
      my_key: "value ⛰️ one",
      market: "DE",
    });

    // Check for an interrupted task
    expect(
      state2.tasks.some(
        (task) =>
          task.name === "tool_two" &&
          task.interrupts &&
          task.interrupts.length > 0 &&
          task.interrupts[0].value === "Just because..."
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

  /**
   * Port of test_checkpoint_metadata from test_pregel_async_checkpoint.py
   */
  it("verifies that a run's configurable fields are merged with checkpoint config", async () => {
    const responses = [
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "tool_call123",
            name: "search_api",
            args: { query: "query" },
          },
        ],
      }),
      new AIMessage({ content: "answer" }),
      new AIMessage({ content: "answer" }),
    ];

    const fakeChatModel = new FakeToolCallingChatModel({
      responses,
    });

    // Create a search tool
    class SearchTool extends StructuredTool {
      name = "search_api";

      description = "Searches the API for the query.";

      schema = z.object({
        query: z.string().describe("The search query"),
      });

      async _call(input: { query: string }): Promise<string> {
        return `result for ${input.query}`;
      }
    }

    const tools = [new SearchTool()];

    // Create prompt
    const prompt = {
      invoke: (state: typeof MessagesAnnotation.State) => {
        return [
          new SystemMessage("You are a nice assistant."),
          ...state.messages,
        ];
      },
    };

    // Agent node function
    const agent = async (state: typeof MessagesAnnotation.State) => {
      const formatted = prompt.invoke(state);
      const response = await fakeChatModel.invoke(formatted);
      return { messages: [new AIMessage(response)] };
    };

    // Should continue function
    const shouldContinue = (data: typeof MessagesAnnotation.State) => {
      const lastMessage = data.messages[data.messages.length - 1];
      if (
        isAIMessage(lastMessage) &&
        (lastMessage.tool_calls?.length ?? 0) > 0
      ) {
        return "continue";
      } else {
        return "exit";
      }
    };

    // Define graph
    const workflow = new StateGraph(MessagesAnnotation)
      .addNode("agent", agent)
      .addNode("tools", new ToolNode(tools))
      .addEdge(START, "agent")
      .addConditionalEdges("agent", shouldContinue, {
        continue: "tools",
        exit: END,
      })
      .addEdge("tools", "agent");

    // Graph without interrupt
    const checkpointer1 = new MemorySaverAssertCheckpointMetadata();
    const app = workflow.compile({ checkpointer: checkpointer1 });

    // Graph with interrupt
    const checkpointer2 = new MemorySaverAssertCheckpointMetadata();
    const appWithInterrupt = workflow.compile({
      checkpointer: checkpointer2,
      interruptBefore: ["tools"],
    });

    // Invoke graph without interrupt
    await app.invoke(
      { messages: [new HumanMessage("what is weather in sf")] },
      {
        configurable: {
          thread_id: "1",
          test_config_1: "foo",
          test_config_2: "bar",
        },
      }
    );

    // Get checkpoint metadata
    const config1 = { configurable: { thread_id: "1" } };
    const checkpointTuple1 = await checkpointer1.getTuple(config1);
    expect(checkpointTuple1).toBeDefined();

    expect(checkpointTuple1).toBeDefined();
    expect(checkpointTuple1?.metadata).toBeDefined();

    const tuple1Metadata = checkpointTuple1!.metadata! as CheckpointMetadata<{
      thread_id: string;
      test_config_1: string;
      test_config_2: string;
    }>;

    // Assert that checkpoint metadata contains the run's configurable fields
    expect(tuple1Metadata.thread_id).toBe("1");
    expect(tuple1Metadata.test_config_1).toBe("foo");
    expect(tuple1Metadata.test_config_2).toBe("bar");

    // Verify that all checkpoint metadata have the expected keys
    for await (const chkpntTuple of checkpointer1.list(config1)) {
      const tplMetadata = chkpntTuple.metadata as CheckpointMetadata<{
        thread_id: string;
        test_config_1: string;
        test_config_2: string;
      }>;
      expect(tplMetadata.thread_id).toBe("1");
      expect(tplMetadata.test_config_1).toBe("foo");
      expect(tplMetadata.test_config_2).toBe("bar");
    }

    // Invoke graph with interrupt
    await appWithInterrupt.invoke(
      { messages: [new HumanMessage("what is weather in sf")] },
      {
        configurable: {
          thread_id: "2",
          test_config_3: "foo",
          test_config_4: "bar",
        },
      }
    );

    // Get checkpoint metadata
    const config2 = { configurable: { thread_id: "2" } };
    const checkpointTuple2 = await checkpointer2.getTuple(config2);
    expect(checkpointTuple2).toBeDefined();

    const tuple2Metadata = checkpointTuple2!.metadata! as CheckpointMetadata<{
      thread_id: string;
      test_config_3: string;
      test_config_4: string;
    }>;

    // Assert that checkpoint metadata contains the run's configurable fields
    expect(tuple2Metadata.thread_id).toBe("2");
    expect(tuple2Metadata.test_config_3).toBe("foo");
    expect(tuple2Metadata.test_config_4).toBe("bar");

    // Resume graph execution
    await appWithInterrupt.invoke(null, {
      configurable: {
        thread_id: "2",
        test_config_3: "foo",
        test_config_4: "bar",
      },
    });

    // Get updated checkpoint metadata
    const checkpointTuple3 = await checkpointer2.getTuple(config2);
    expect(checkpointTuple3).toBeDefined();

    const tuple3Metadata = checkpointTuple3!.metadata! as CheckpointMetadata<{
      thread_id: string;
      test_config_3: string;
      test_config_4: string;
    }>;

    // Assert that checkpoint metadata contains the run's configurable fields
    expect(tuple3Metadata.thread_id).toBe("2");
    expect(tuple3Metadata.test_config_3).toBe("foo");
    expect(tuple3Metadata.test_config_4).toBe("bar");

    // Verify that all checkpoint metadata have the expected keys
    for await (const chkpntTuple of checkpointer2.list(config2)) {
      const tplMetadata = chkpntTuple.metadata as CheckpointMetadata<{
        thread_id: string;
        test_config_3: string;
        test_config_4: string;
      }>;
      expect(tplMetadata.thread_id).toBe("2");
      expect(tplMetadata.test_config_3).toBe("foo");
      expect(tplMetadata.test_config_4).toBe("bar");
    }
  });

  /**
   * Port of test_checkpointer_null_pending_writes from test_pregel_async_checkpoint.py
   */
  it("should handle checkpoint with null pending writes", async () => {
    // Create a MemorySaverNoPending implementation
    class MemorySaverNoPending extends MemorySaver {
      async getTuple(
        config: RunnableConfig
      ): Promise<CheckpointTuple | undefined> {
        const result = await super.getTuple(config);
        if (result) {
          // Return a CheckpointTuple without the pendingWrites property
          const { config: resultConfig, checkpoint, metadata } = result;
          return {
            config: resultConfig,
            checkpoint,
            metadata,
          };
        }
        return result;
      }
    }

    // Set up an Annotation for the array reducer
    const StateAnnotation = Annotation.Root({
      value: Annotation<string[]>({
        reducer: (a, b) => [...(a || []), ...b],
        default: () => [],
      }),
    });

    // Create a simple node that just returns its name
    class Node {
      name: string;

      constructor(name: string) {
        this.name = name;
      }

      call(): typeof StateAnnotation.Update {
        return { value: [this.name] };
      }
    }

    // Create a graph with the node
    const builder = new StateGraph({ stateSchema: StateAnnotation })
      .addNode("1", new Node("1").call)
      .addEdge(START, "1");

    // Compile the graph with our special checkpointer
    const graph = builder.compile({
      checkpointer: new MemorySaverNoPending(),
    });

    // First invocation should return ["1"]
    const result1 = await graph.invoke(
      { value: [] },
      { configurable: { thread_id: "foo" } }
    );
    expect(result1.value).toEqual(["1"]);

    // Second invocation should return ["1", "1"]
    const result2 = await graph.invoke(
      { value: [] },
      { configurable: { thread_id: "foo" } }
    );
    expect(result2.value).toEqual(["1", "1"]);

    // Third invocation (async) should return ["1", "1", "1"]
    const result3 = await graph.invoke(
      { value: [] },
      { configurable: { thread_id: "foo" } }
    );
    expect(result3.value).toEqual(["1", "1", "1"]);

    // Fourth invocation (async) should return ["1", "1", "1", "1"]
    const result4 = await graph.invoke(
      { value: [] },
      { configurable: { thread_id: "foo" } }
    );
    expect(result4.value).toEqual(["1", "1", "1", "1"]);
  });
});

/**
 * Port of test_store_injected_async from test_pregel_async_checkpoint.py
 */
describe("Long-term Memory Store Tests (Python port)", () => {
  it("should pass store to nodes correctly", async () => {
    // Define Annotation for state
    const StateAnnotation = Annotation.Root({
      count: Annotation<number>({
        reducer: (a, b) => a + b,
        default: () => 0,
      }),
    });

    // Test setup similar to the Python test
    const docId = uuidv4();
    const doc = { "some-key": "this-is-a-val" };
    const uid = uuidv4().replace(/-/g, "");
    const namespace = [`foo-${uid}`, "bar"];
    const thread1 = uuidv4();
    const thread2 = uuidv4();

    // Define a node that accesses store from config.store
    const getNodeFunc =
      (i?: number) =>
      async (
        state: typeof StateAnnotation.State,
        config: LangGraphRunnableConfig
      ) => {
        // Access the store from config.store, which is how it's passed in JS
        const { store } = config;
        expect(store).toBeDefined();

        const putNamespace =
          i !== undefined &&
          [thread1, thread2].includes(config.configurable?.thread_id)
            ? namespace
            : [`foo_${i ?? ""}`, "bar"];

        if (store) {
          // Use the store to write data
          await store.put(putNamespace, docId, {
            ...doc,
            from_thread: config.configurable?.thread_id,
            some_val: state.count,
          });
        }

        return { count: 1 };
      };

    // Another node that also uses the store
    const otherNodeFunc = async (
      _state: typeof StateAnnotation.State,
      config: LangGraphRunnableConfig
    ) => {
      // Access the store from config.store
      const store = config.store as BaseStore | undefined;
      expect(store).toBeDefined();

      if (store) {
        // Read from the store
        const item = await store.get(namespace, docId);
        expect(item).toBeDefined();

        await store.put(["not", "interesting"], "key", { val: "val" });
      }

      return { count: 0 };
    };

    // Create a simple graph
    const builder = new StateGraph<
      typeof StateAnnotation.spec,
      typeof StateAnnotation.State,
      typeof StateAnnotation.Update,
      string
    >({ stateSchema: StateAnnotation })
      .addNode("node", getNodeFunc())
      .addNode("other_node", otherNodeFunc)
      .addEdge(START, "node")
      .addEdge("node", "other_node");

    const N = 50;

    for (let i = 0; i < N; i += 1) {
      builder.addNode(`node_${i}`, getNodeFunc(i));
      builder.addEdge(START, `node_${i}`);
    }

    const checkpointer = new MemorySaver();

    // Use InMemoryStore implementation
    const store = new InMemoryStore();

    // Compile the graph with the store
    const graph = builder.compile({
      store,
      checkpointer,
    });

    // First invocation
    const result = await graph.batch(
      [{ count: 0 }],
      [
        {
          configurable: { thread_id: thread1 },
        },
      ]
    );

    // Check the result
    expect(result.length).toBe(1);
    expect(result[0].count).toBe(N + 1);

    // Verify data was written correctly
    const returnedDoc = await store.get(namespace, docId);
    expect(returnedDoc).toBeDefined();
    expect(returnedDoc?.value).toEqual({
      ...doc,
      from_thread: thread1,
      some_val: 0,
    });

    expect((await store.search(namespace)).length).toBe(1);

    // Second invocation with different thread
    const result2 = await graph.invoke(
      { count: 0 },
      { configurable: { thread_id: thread1 } }
    );

    // Check the result
    expect(result2.count).toBe((N + 1) * 2);

    const returnedDoc2 = await store.get(namespace, docId);
    expect(returnedDoc2).toBeDefined();
    expect(returnedDoc2?.value).toEqual({
      ...doc,
      from_thread: thread1,
      some_val: N + 1,
    });

    expect((await store.search(namespace)).length).toBe(1);

    // Test with a different thread
    const result3 = await graph.invoke(
      { count: 0 },
      { configurable: { thread_id: thread2 } }
    );

    expect(result3.count).toBe(N + 1);

    const returnedDoc3 = await store.get(namespace, docId);
    expect(returnedDoc3).toBeDefined();
    expect(returnedDoc3?.value).toEqual({
      ...doc,
      from_thread: thread2,
      some_val: 0,
    });

    expect((await store.search(namespace)).length).toBe(1);
  });
});

/**
 * Port of test_checkpoint_recovery_async from test_pregel_async_checkpoint.py
 */
describe("Checkpoint Recovery Tests (Python port)", () => {
  it("should recover from checkpoints after failures with async nodes", async () => {
    // Create state annotation with steps and attempt
    const StateAnnotation = Annotation.Root({
      steps: Annotation<string[]>({
        reducer: (a, b) => [...(a || []), ...(b || [])],
        default: () => [],
      }),
      attempt: Annotation<number>({
        reducer: (_, b) => b,
        default: () => 0,
      }),
    });

    // Helper function for controlled delays
    const delay = (ms: number) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      });

    // Node that fails on first attempt, succeeds on retry
    const failingNode = async (
      state: typeof StateAnnotation.State
    ): Promise<typeof StateAnnotation.Update> => {
      // Fail on first attempt, succeed on retry
      if (state.attempt === 1) {
        throw new Error("Simulated failure");
      }
      await delay(100); // Simulate async work
      return { steps: ["node1"] };
    };

    // Second node for the pipeline
    const secondNode = async (
      _state: typeof StateAnnotation.State
    ): Promise<typeof StateAnnotation.Update> => {
      await delay(100); // Simulate async work
      return { steps: ["node2"] };
    };

    // Create the graph
    const builder = new StateGraph({
      stateSchema: StateAnnotation,
    })
      .addNode("node1", failingNode)
      .addNode("node2", secondNode)
      .addEdge(START, "node1")
      .addEdge("node1", "node2");

    // Use MemorySaver directly
    const saver = new MemorySaver();
    const graph = builder.compile({ checkpointer: saver });
    const config = { configurable: { thread_id: "1" } };

    // First attempt should fail
    await expect(
      graph.invoke({ steps: ["start"], attempt: 1 }, config)
    ).rejects.toThrow("Simulated failure");

    // Verify checkpoint state
    const state = await graph.getState(config);
    expect(state).not.toBeNull();
    expect(state?.values).toEqual({ steps: ["start"], attempt: 1 }); // input state saved
    expect(state?.next).toEqual(["node1"]); // Should retry failed node

    // Retry with updated attempt count
    const result = await graph.invoke({ steps: [], attempt: 2 }, config);
    expect(result).toEqual({ steps: ["start", "node1", "node2"], attempt: 2 });

    // Verify checkpoint history shows both attempts
    const history = await gatherIterator(graph.getStateHistory(config));

    expect(history.length).toBe(6); // Initial + failed attempt + successful attempt

    // Verify the error was recorded in checkpoint
    const failedCheckpoint = history.find((c) => c.tasks && c.tasks[0]?.error);
    expect(failedCheckpoint?.tasks?.[0]?.error).toHaveProperty(
      "message",
      "Simulated failure"
    );
  });
});
