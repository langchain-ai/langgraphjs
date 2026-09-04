/**
 * Covers how a failing checkpointer is reported under "async" durability,
 * where nothing awaits persistence until the run's finalize barrier. A
 * rejection must reach that barrier without Node seeing it as unhandled, and
 * one failed `put()` must not cancel the checkpoints queued behind it.
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import type {
  Checkpoint,
  CheckpointMetadata,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";
import { afterEach, describe, expect, it } from "vitest";

import { Annotation, StateGraph } from "../graph/index.js";
import { END, START } from "../constants.js";

function macrotask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
}

class FailingWritesSaver extends MemorySaver {
  private shouldFailNextWrites = true;

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    if (this.shouldFailNextWrites) {
      this.shouldFailNextWrites = false;
      throw new Error("putWrites failed");
    }
    return super.putWrites(config, writes, taskId);
  }
}

class FailFirstCheckpointSaver extends MemorySaver {
  readonly attemptedSteps: number[] = [];

  private shouldFailNextPut = true;

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    this.attemptedSteps.push(metadata.step);
    if (this.shouldFailNextPut) {
      this.shouldFailNextPut = false;
      throw new Error("put failed");
    }
    return super.put(config, checkpoint, metadata);
  }
}

function createGraph() {
  const State = Annotation.Root({ value: Annotation<string> });
  return new StateGraph(State)
    .addNode("first", () => ({ value: "first" }))
    .addNode("second", async () => {
      await macrotask();
      return { value: "second" };
    })
    .addNode("third", () => ({ value: "third" }))
    .addEdge(START, "first")
    .addEdge("first", "second")
    .addEdge("second", "third")
    .addEdge("third", END);
}

describe("async durability persistence failures", () => {
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandled.push(reason);
  };

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
    unhandled.length = 0;
  });

  it("surfaces a putWrites failure at the end of the run without an unhandled rejection", async () => {
    process.on("unhandledRejection", onUnhandledRejection);

    const graph = createGraph().compile({ checkpointer: new FailingWritesSaver() });

    await expect(
      graph.invoke(
        { value: "input" },
        { configurable: { thread_id: "async-put-writes-failure" } },
      ),
    ).rejects.toThrow("putWrites failed");

    // Give Node a turn to flag any rejection it considers unobserved.
    await macrotask();

    expect(unhandled).toEqual([]);
  });

  it("keeps checkpointing after a failed put instead of skipping the rest of the run", async () => {
    process.on("unhandledRejection", onUnhandledRejection);

    const saver = new FailFirstCheckpointSaver();
    const graph = createGraph().compile({ checkpointer: saver });
    const config = { configurable: { thread_id: "async-put-failure" } };

    await expect(graph.invoke({ value: "input" }, config)).rejects.toThrow(
      "put failed",
    );

    await macrotask();

    expect(saver.attemptedSteps.length).toBeGreaterThan(1);
    expect(unhandled).toEqual([]);

    const persisted = await saver.getTuple(config);
    expect(persisted?.checkpoint).toBeDefined();
    expect(persisted?.metadata?.step).toBe(
      saver.attemptedSteps[saver.attemptedSteps.length - 1],
    );
  });
});
