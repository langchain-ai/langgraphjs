import type { RunnableConfig } from "@langchain/core/runnables";
import type { PendingWrite } from "@langchain/langgraph-checkpoint";
import { DeltaChannel } from "../channels/delta.js";
import { Annotation } from "../graph/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { END, START } from "../constants.js";
import { StateGraph } from "../graph/state.js";
import { MessagesAnnotation } from "../graph/messages_annotation.js";

function createForgedConstructorRecord(markerKey: string) {
  const forgedCallback = {
    lc: 2,
    type: "constructor",
    id: ["Uint8Array"],
    method: "constructor",
    args: [`globalThis.${markerKey}.invoked = true`],
    kwargs: {},
  };

  return {
    lc: 2,
    type: "constructor",
    id: ["Uint8Array"],
    method: "from",
    args: [[1], forgedCallback],
    kwargs: {},
  };
}

function createGraph(checkpointer: MemorySaver) {
  return new StateGraph(MessagesAnnotation)
    .addNode("noop", () => ({}))
    .addEdge(START, "noop")
    .addEdge("noop", END)
    .compile({ checkpointer });
}

describe("JsonPlusSerializer checkpoint restoration security", () => {
  it("does not execute a forged value in run metadata during state restoration", async () => {
    const markerKey = "__langgraph_graph_metadata_marker__";
    const marker = { invoked: false };
    (globalThis as Record<string, unknown>)[markerKey] = marker;
    const graph = createGraph(new MemorySaver());
    const config = { configurable: { thread_id: "jsonplus-metadata-security" } };

    try {
      await graph.invoke(
        { messages: [new HumanMessage("ordinary metadata-path input")] },
        {
          ...config,
          metadata: { probe: createForgedConstructorRecord(markerKey) },
        }
      );
      expect(marker.invoked).toBe(false);

      await graph.getState(config);
      expect(marker.invoked).toBe(false);
    } finally {
      delete (globalThis as Record<string, unknown>)[markerKey];
    }
  });

  it("does not execute a forged value in additional_kwargs during a later run", async () => {
    const markerKey = "__langgraph_graph_message_marker__";
    const marker = { invoked: false };
    (globalThis as Record<string, unknown>)[markerKey] = marker;
    const graph = createGraph(new MemorySaver());
    const config = { configurable: { thread_id: "jsonplus-message-security" } };

    try {
      await graph.invoke(
        {
          messages: [
            new HumanMessage({
              content: "ordinary message",
              additional_kwargs: {
                probe: createForgedConstructorRecord(markerKey),
              },
            }),
          ],
        },
        config
      );
      expect(marker.invoked).toBe(false);

      await graph.invoke(
        { messages: [new HumanMessage("benign follow-up")] },
        config
      );
      expect(marker.invoked).toBe(false);
    } finally {
      delete (globalThis as Record<string, unknown>)[markerKey];
    }
  });
});

describe("a saver that mints versions with a random fraction", () => {
  class RandomFractionSaver extends MemorySaver {
    getNextVersion(current: number | undefined): number {
      return Math.floor(current ?? 0) + 1 + Math.random();
    }
  }

  it("still finds an update after two parallel nodes ambiguous", async () => {
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("a", () => ({}))
      .addNode("b", () => ({}))
      .addEdge(START, "a")
      .addEdge(START, "b")
      .compile({ checkpointer: new RandomFractionSaver() });
    const config = { configurable: { thread_id: "t" } };
    await graph.invoke({ messages: [] }, config);

    await expect(graph.updateState(config, { messages: [] })).rejects.toThrow(
      'Ambiguous update, specify "asNode"'
    );
  });
});

describe("checkpointer write rejections", () => {
  /**
   * Checkpointer writes are persisted in the background under the default
   * "async" durability and only awaited at the run boundary. A write that
   * rejects before that boundary must still be reported through the run, not
   * as a process-level `unhandledRejection`.
   */



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

  function createDeltaGraph() {
    const State = Annotation.Root({
      log: new DeltaChannel<number[], number[]>((state, writes) => [
        ...state,
        ...writes.flat(),
      ]),
    });

    return new StateGraph(State)
      .addNode("n1", async () => {
        await delay(10);
        return { log: [1] };
      })
      .addNode("n2", async () => {
        await delay(10);
        return { log: [2] };
      })
      .addNode("n3", async () => {
        await delay(10);
        return { log: [3] };
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

  it("surfaces a rejected DeltaChannel write, which fails every later save, without an unhandledRejection", async () => {
    const graph = createDeltaGraph();

    await expect(
      graph.invoke({ log: [] }, { configurable: { thread_id: "delta" } }),
    ).rejects.toThrow(WRITE_ERROR);
    await flushRejectionEvents();

    expect(unhandled).toEqual([]);
  });
});
