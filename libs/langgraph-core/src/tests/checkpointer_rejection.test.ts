/**
 * Checkpointer writes are persisted in the background under the default
 * "async" durability and only awaited at the run boundary. A write that
 * rejects before that boundary must still be reported through the run, not
 * as a process-level `unhandledRejection`.
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import type { PendingWrite } from "@langchain/langgraph-checkpoint";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Annotation, StateGraph } from "../graph/index.js";
import { END, START } from "../constants.js";

const WRITE_ERROR = "simulated: sorry, too many clients already";

class RejectingPutWritesSaver extends MemorySaver {
  override async putWrites(
    _config: RunnableConfig,
    _writes: PendingWrite[],
    _taskId: string,
  ): Promise<void> {
    throw new Error(WRITE_ERROR);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Nodes yield to the event loop so that a write rejected after one node
// settles before the run reaches its end-of-run barrier, which is the
// timing that lets a rejection escape as a process-level event.
function createGraph() {
  const State = Annotation.Root({
    value: Annotation<number>({ reducer: (a: number, b: number) => a + b }),
  });

  return new StateGraph(State)
    .addNode("n1", async () => {
      await delay(10);
      return { value: 1 };
    })
    .addNode("n2", async () => {
      await delay(10);
      return { value: 2 };
    })
    .addNode("n3", async () => {
      await delay(10);
      return { value: 3 };
    })
    .addEdge(START, "n1")
    .addEdge("n1", "n2")
    .addEdge("n2", "n3")
    .addEdge("n3", END)
    .compile({ checkpointer: new RejectingPutWritesSaver() });
}

function flushRejectionEvents(): Promise<void> {
  return delay(0);
}

describe("checkpointer write rejections", () => {
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandledRejection);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
  });

  it("surfaces a rejected write through invoke without an unhandledRejection", async () => {
    const graph = createGraph();

    await expect(
      graph.invoke({ value: 0 }, { configurable: { thread_id: "invoke" } }),
    ).rejects.toThrow(WRITE_ERROR);
    await flushRejectionEvents();

    expect(unhandled).toEqual([]);
  });

  it("surfaces a rejected write through a fully consumed stream without an unhandledRejection", async () => {
    const graph = createGraph();
    const stream = await graph.stream(
      { value: 0 },
      { configurable: { thread_id: "stream" }, streamMode: "updates" },
    );

    let surfaced: unknown;
    try {
      for await (const _chunk of stream) {
        // consume to completion
      }
    } catch (error) {
      surfaced = error;
    }
    await flushRejectionEvents();

    expect(surfaced).toBeInstanceOf(Error);
    expect((surfaced as Error).message).toBe(WRITE_ERROR);
    expect(unhandled).toEqual([]);
  });
});
