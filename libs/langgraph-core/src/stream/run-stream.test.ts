import { describe, expect, it } from "vitest";
import {
  GraphRunStream,
  SubgraphRunStream,
  createGraphRunStream,
} from "./run-stream.js";
import { StreamMux } from "./mux.js";
import type { SubgraphStreamFactory } from "./mux.js";
import type { ProtocolEvent, StreamTransformer } from "./types.js";

const subgraphFactory: SubgraphStreamFactory = (path, mux, discoveryStart, eventStart) =>
  new SubgraphRunStream(path, mux, discoveryStart, eventStart);

function makeEvent(
  method: string,
  ns: string[] = [],
  data: unknown = {},
  seq = 0
): ProtocolEvent {
  return {
    type: "event",
    seq,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    method: method as any,
    params: { namespace: ns, timestamp: Date.now(), data },
  };
}

async function collect<T>(iter: AsyncIterator<T>): Promise<T[]> {
  const out: T[] = [];
  for (;;) {
    const r = await iter.next();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function* makeSource(
  chunks: [string[], string, unknown][]
): AsyncGenerator<any> {
  for (const chunk of chunks) yield chunk;
}

describe("GraphRunStream", () => {
  it("iterates protocol events via [Symbol.asyncIterator]", async () => {
    const mux = new StreamMux();
    const stream = new GraphRunStream([], mux);
    mux.register([], stream);

    const e1 = makeEvent("values", [], { count: 1 }, 0);
    const e2 = makeEvent("updates", [], { count: 2 }, 1);

    mux.push([], e1);
    mux.push([], e2);
    mux.close();

    const events = await collect(stream[Symbol.asyncIterator]());
    expect(events).toHaveLength(2);
    expect(events[0].method).toBe("values");
    expect(events[1].method).toBe("updates");
  });

  it("subgraphs getter yields SubgraphRunStream on discovery", async () => {
    const mux = new StreamMux(subgraphFactory);
    const root = new GraphRunStream([], mux);
    mux.register([], root);

    const childEvent = makeEvent("values", ["child:0"], { x: 1 }, 0);
    mux.push(["child:0"], childEvent);
    mux.close();

    const subs: SubgraphRunStream[] = [];
    for await (const sub of root.subgraphs) {
      subs.push(sub);
    }

    expect(subs).toHaveLength(1);
    expect(subs[0]).toBeInstanceOf(SubgraphRunStream);
    expect(subs[0].name).toBe("child");
    expect(subs[0].index).toBe(0);
  });

  it("values getter provides both AsyncIterable and PromiseLike", async () => {
    const mux = new StreamMux();
    const root = new GraphRunStream([], mux);
    mux.register([], root);

    const v1 = makeEvent("values", [], { step: 1 }, 0);
    const v2 = makeEvent("values", [], { step: 2 }, 1);

    mux.push([], v1);
    mux.push([], v2);
    mux.close();

    const vals = root.values;

    expect(typeof vals.then).toBe("function");
    expect(typeof vals[Symbol.asyncIterator]).toBe("function");

    const collected: unknown[] = [];
    for await (const v of vals) {
      collected.push(v);
    }
    expect(collected).toEqual([{ step: 1 }, { step: 2 }]);
  });

  it("output resolves when _resolveValues is called", async () => {
    const mux = new StreamMux();
    const root = new GraphRunStream<{ answer: number }>([], mux);

    const outputPromise = root.output;
    root._resolveValues({ answer: 42 });

    const result = await outputPromise;
    expect(result).toEqual({ answer: 42 });
  });

  it("output rejects when _rejectValues is called", async () => {
    const mux = new StreamMux();
    const root = new GraphRunStream([], mux);

    const outputPromise = root.output;
    root._rejectValues(new Error("run failed"));

    await expect(outputPromise).rejects.toThrow("run failed");
  });

  it("messages getter returns fallback iterable when not set", () => {
    const mux = new StreamMux();
    const root = new GraphRunStream([], mux);

    const iterable = root.messages;
    expect(typeof iterable[Symbol.asyncIterator]).toBe("function");
  });

  it("messages getter returns provided iterable when set", async () => {
    const mux = new StreamMux();
    const root = new GraphRunStream([], mux);

    const items = [{ fake: "message" }];
    const custom: AsyncIterable<any> = {
      async *[Symbol.asyncIterator]() {
        for (const item of items) yield item;
      },
    };

    root._setMessagesIterable(custom);
    const collected: unknown[] = [];
    for await (const msg of root.messages) {
      collected.push(msg);
    }
    expect(collected).toEqual([{ fake: "message" }]);
  });

  it("interrupted and interrupts delegate to mux", () => {
    const mux = new StreamMux();
    const root = new GraphRunStream([], mux);

    expect(root.interrupted).toBe(false);
    expect(root.interrupts).toEqual([]);

    mux.markInterrupted([
      { interruptId: "int-1", payload: { question: "continue?" } },
    ]);

    expect(root.interrupted).toBe(true);
    expect(root.interrupts).toHaveLength(1);
    expect(root.interrupts[0].interruptId).toBe("int-1");
  });

  it("abort() triggers the signal", () => {
    const mux = new StreamMux();
    const root = new GraphRunStream([], mux);

    expect(root.signal.aborted).toBe(false);
    root.abort("cancelled");
    expect(root.signal.aborted).toBe(true);
    expect(root.signal.reason).toBe("cancelled");
  });

  it("signal getter returns abort signal", () => {
    const controller = new AbortController();
    const mux = new StreamMux();
    const root = new GraphRunStream([], mux, 0, 0, undefined, controller);

    expect(root.signal).toBe(controller.signal);
  });
});

describe("SubgraphRunStream", () => {
  it("parses name from last path segment", () => {
    const mux = new StreamMux();
    const sub = new SubgraphRunStream(["agent"], mux);
    expect(sub.name).toBe("agent");
  });

  it("parses index from 'name:N' suffix", () => {
    const mux = new StreamMux();
    const sub = new SubgraphRunStream(["parent", "child:3"], mux);
    expect(sub.name).toBe("child");
    expect(sub.index).toBe(3);
  });

  it("defaults index to 0 when no numeric suffix", () => {
    const mux = new StreamMux();

    const noColon = new SubgraphRunStream(["nodeName"], mux);
    expect(noColon.name).toBe("nodeName");
    expect(noColon.index).toBe(0);

    const nonNumeric = new SubgraphRunStream(["node:abc"], mux);
    expect(nonNumeric.name).toBe("node");
    expect(nonNumeric.index).toBe(0);
  });

  it("inherits GraphRunStream functionality", async () => {
    const mux = new StreamMux();
    const sub = new SubgraphRunStream<{ v: number }>(["sub:0"], mux);
    mux.register(["sub:0"], sub);

    const e = makeEvent("values", ["sub:0"], { v: 10 }, 0);
    mux.push(["sub:0"], e);
    mux.close();

    const events = await collect(sub[Symbol.asyncIterator]());
    expect(events).toHaveLength(1);
    expect(events[0].params.data).toEqual({ v: 10 });

    expect(sub.interrupted).toBe(false);
    expect(sub.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("createGraphRunStream", () => {
  it("creates a stream that iterates events from source", async () => {
    const source = makeSource([
      [[], "values", { a: 1 }],
      [[], "updates", { node: "n", values: {} }],
    ]);

    const stream = createGraphRunStream(source);
    const events: ProtocolEvent[] = [];
    for await (const e of stream) {
      events.push(e);
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    const methods = events.map((e) => e.method);
    expect(methods).toContain("values");
  });

  it("output resolves with final values from source", async () => {
    const source = makeSource([
      [[], "values", { step: 1 }],
      [[], "values", { step: 2 }],
    ]);

    const stream = createGraphRunStream<{ step: number }>(source);
    const result = await stream.output;
    expect(result).toEqual({ step: 2 });
  });

  it("custom transformers receive events and produce extensions", async () => {
    let processedCount = 0;

    const customTransformerFactory = (): StreamTransformer<{ counter: number }> => ({
      init: () => ({ counter: 0 }),
      process(_event: ProtocolEvent): boolean {
        processedCount += 1;
        return true;
      },
      finalize(): void {},
      fail(): void {},
    });

    const source = makeSource([
      [[], "values", { x: 1 }],
      [[], "values", { x: 2 }],
    ]);

    const stream = createGraphRunStream(source, [customTransformerFactory]);
    await stream.output;

    expect(processedCount).toBeGreaterThan(0);
    expect(stream.extensions).toHaveProperty("counter");
  });

  it("processes values mode events through ValuesReducer", async () => {
    const source = makeSource([
      [[], "values", { count: 10 }],
      [[], "values", { count: 20 }],
      [[], "values", { count: 30 }],
    ]);

    const stream = createGraphRunStream<{ count: number }>(source);

    const collected: Array<{ count: number }> = [];
    for await (const v of stream.values) {
      collected.push(v);
    }

    expect(collected).toEqual([
      { count: 10 },
      { count: 20 },
      { count: 30 },
    ]);
  });
});
