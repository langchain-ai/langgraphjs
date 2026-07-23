/**
 * Exercises the scheduler boundary for checkpoint durability. The custom saver
 * blocks both `putWrites()` and the completed superstep's checkpoint `put()`.
 * Sync runs must not dispatch the following node until both operations settle;
 * async runs may dispatch it while they remain pending. The sync cases cover
 * invoke, stream, and streamEvents, which all share the Pregel scheduler.
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import type {
  Checkpoint,
  CheckpointMetadata,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";
import { describe, expect, it } from "vitest";

import { Annotation, StateGraph } from "../graph/index.js";
import { END, START } from "../constants.js";

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {
    throw new Error("Deferred promise resolver was not initialized");
  };
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function yieldToScheduler(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

class GateFirstSuperstepPersistenceSaver extends MemorySaver {
  private readonly firstLoopCheckpointStarted = createDeferred();

  private readonly firstTaskWritesStarted = createDeferred();

  private readonly checkpointGate = createDeferred();

  private readonly writesGate = createDeferred();

  private shouldGateFirstLoopCheckpoint = true;

  private shouldGateFirstTaskWrites = true;

  get waitForFirstSuperstepPersistence(): Promise<void> {
    return Promise.all([
      this.firstLoopCheckpointStarted.promise,
      this.firstTaskWritesStarted.promise,
    ]).then(() => undefined);
  }

  releaseFirstSuperstepPersistence(): void {
    this.checkpointGate.resolve();
    this.writesGate.resolve();
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    if (this.shouldGateFirstLoopCheckpoint && metadata.source === "loop") {
      this.shouldGateFirstLoopCheckpoint = false;
      this.firstLoopCheckpointStarted.resolve();
      await this.checkpointGate.promise;
    }
    return super.put(config, checkpoint, metadata);
  }

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    if (this.shouldGateFirstTaskWrites) {
      this.shouldGateFirstTaskWrites = false;
      this.firstTaskWritesStarted.resolve();
      await this.writesGate.promise;
    }
    return super.putWrites(config, writes, taskId);
  }
}

type ExecutionMode = "invoke" | "stream" | "streamEvents";

function createGraph(secondNodeStarted: () => void) {
  const State = Annotation.Root({ value: Annotation<string> });
  return new StateGraph(State)
    .addNode("first", () => ({ value: "first" }))
    .addNode("second", () => {
      secondNodeStarted();
      return { value: "second" };
    })
    .addEdge(START, "first")
    .addEdge("first", "second")
    .addEdge("second", END);
}

describe("sync durability", () => {
  it.each<ExecutionMode>(["invoke", "stream", "streamEvents"])(
    "waits for completed-superstep persistence before dispatching the next node via %s",
    async (mode) => {
      const saver = new GateFirstSuperstepPersistenceSaver();
      let secondStarted = false;
      const graph = createGraph(() => {
        secondStarted = true;
      }).compile({ checkpointer: saver });
      const options = {
        configurable: { thread_id: `sync-${mode}` },
        durability: "sync" as const,
      };

      let execution: Promise<void>;
      if (mode === "invoke") {
        execution = graph
          .invoke({ value: "input" }, options)
          .then(() => undefined);
      } else if (mode === "stream") {
        execution = (async () => {
          const stream = await graph.stream({ value: "input" }, options);
          for await (const _chunk of stream) {
            // Consume the stream so the run can complete after the gate opens.
          }
        })();
      } else {
        execution = (async () => {
          const stream = graph.streamEvents(
            { value: "input" },
            {
              ...options,
              version: "v2",
            },
          );
          for await (const _event of stream) {
            // Consume the stream so the run can complete after the gate opens.
          }
        })();
      }

      try {
        await saver.waitForFirstSuperstepPersistence;
        // Without the sync barrier, yielding here gives _runLoop a chance to
        // dispatch the next node while both persistence operations are gated.
        await yieldToScheduler();
        expect(secondStarted).toBe(false);
      } finally {
        saver.releaseFirstSuperstepPersistence();
        await execution;
        expect(secondStarted).toBe(true);
      }
    },
  );

  it("allows the next node to start while prior persistence is pending in async mode", async () => {
    const saver = new GateFirstSuperstepPersistenceSaver();
    const secondNodeStarted = createDeferred();
    const graph = createGraph(secondNodeStarted.resolve).compile({
      checkpointer: saver,
    });

    const execution = graph.invoke(
      { value: "input" },
      {
        configurable: { thread_id: "async" },
        durability: "async",
      },
    );

    try {
      await saver.waitForFirstSuperstepPersistence;
      await secondNodeStarted.promise;
    } finally {
      saver.releaseFirstSuperstepPersistence();
    }
    await expect(execution).resolves.toEqual({ value: "second" });
  });
});
