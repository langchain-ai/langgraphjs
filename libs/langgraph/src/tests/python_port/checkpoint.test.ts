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
import { Annotation, END, Graph, START } from "../../index.js";
import { gatherIterator } from "../../utils.js";

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

describe("checkpoint errors (Python port)", () => {
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
});
