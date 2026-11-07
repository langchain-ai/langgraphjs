import { describe, it, expect } from "vitest";
import { Annotation, END, START, StateGraph } from "../../web.js";
import type { IterableReadableStreamWithAbortSignal } from "../../pregel/stream.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `a -> b -> c`. `a` finishes at once, `b` and `c` take a while, so a
 * consumer that stops reading after the first chunk leaves the run with
 * unfinished work that it should not start.
 */
function buildGraph(log: string[]) {
  return new StateGraph(Annotation.Root({ value: Annotation<number> }))
    .addNode("a", () => {
      log.push("a");
      return { value: 1 };
    })
    .addNode("b", async () => {
      log.push("b");
      await sleep(100);
      return { value: 2 };
    })
    .addNode("c", async () => {
      log.push("c");
      await sleep(100);
      return { value: 3 };
    })
    .addEdge(START, "a")
    .addEdge("a", "b")
    .addEdge("b", "c")
    .addEdge("c", END)
    .compile();
}

// Long enough for `b` (100 ms) to finish and `c` to start if the run goes on.
const SETTLE_MS = 400;

describe("stopping a stream stops the run", () => {
  it("stops when a `for await` loop over stream() breaks", async () => {
    const log: string[] = [];
    const graph = buildGraph(log);

    for await (const _chunk of await graph.stream(
      { value: 0 },
      { streamMode: "updates" }
    )) {
      break;
    }
    await sleep(SETTLE_MS);

    expect(log).not.toContain("c");
  });

  it("stops when a text/event-stream reader is cancelled", async () => {
    const log: string[] = [];
    const graph = buildGraph(log);

    const stream = await graph.stream(
      { value: 0 },
      { streamMode: "updates", encoding: "text/event-stream" }
    );
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    await sleep(SETTLE_MS);

    expect(log).not.toContain("c");
  });

  it("stops when a `for await` loop over streamEvents() breaks", async () => {
    const log: string[] = [];
    const graph = buildGraph(log);

    for await (const _event of graph.streamEvents(
      { value: 0 },
      { version: "v2" }
    )) {
      break;
    }
    await sleep(SETTLE_MS);

    expect(log).not.toContain("c");
  });

  it("stops a subgraph run when the consumer breaks", async () => {
    const log: string[] = [];
    const parent = new StateGraph(Annotation.Root({ value: Annotation<number> }))
      .addNode("child", buildGraph(log))
      .addEdge(START, "child")
      .addEdge("child", END)
      .compile();

    for await (const _chunk of await parent.stream(
      { value: 0 },
      { streamMode: "updates", subgraphs: true }
    )) {
      break;
    }
    await sleep(SETTLE_MS);

    expect(log).not.toContain("c");
  });

  it("still stops on an explicit stream.cancel()", async () => {
    const log: string[] = [];
    const graph = buildGraph(log);

    const stream = await graph.stream({ value: 0 }, { streamMode: "updates" });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    await stream.cancel();
    await sleep(SETTLE_MS);

    expect(log).not.toContain("c");
  });

  it("aborts the signal of the stream when the consumer breaks", async () => {
    const graph = buildGraph([]);

    const stream = (await graph.stream(
      { value: 0 },
      { streamMode: "updates" }
    )) as IterableReadableStreamWithAbortSignal<unknown>;
    for await (const _chunk of stream) {
      break;
    }

    expect(stream.signal.aborted).toBe(true);
  });

  it("does not throw when breaking or cancelling after the run finished", async () => {
    const log: string[] = [];
    const graph = buildGraph(log);

    const stream = await graph.stream({ value: 0 }, { streamMode: "updates" });
    const chunks: unknown[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(3);
    expect(log).toEqual(["a", "b", "c"]);

    const finished = await graph.stream({ value: 0 }, { streamMode: "updates" });
    const reader = finished.getReader();
    while (!(await reader.read()).done) {
      // drain
    }
    await expect(reader.cancel()).resolves.toBeUndefined();
  });
});
