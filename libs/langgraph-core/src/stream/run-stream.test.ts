import { describe, expect, it } from "vitest";
import {
  GraphRunStream,
  SubgraphRunStream,
  createGraphRunStream,
  SET_MESSAGES_ITERABLE,
} from "./run-stream.js";
import { RESOLVE_VALUES, REJECT_VALUES } from "./mux.js";
import { StreamMux } from "./mux.js";
import {
  collectIterator as collect,
  makeProtocolEvent,
} from "./test-utils.js";
import type {
  NativeStreamTransformer,
  ProtocolEvent,
  StreamTransformer,
} from "./types.js";
import { StreamChannel } from "./stream-channel.js";
import { createSubgraphDiscoveryTransformer } from "./transformers/index.js";

function installSubgraphDiscovery(mux: StreamMux): void {
  const transformer = createSubgraphDiscoveryTransformer(mux, {
    createStream: (path, discoveryStart, eventStart) =>
      new SubgraphRunStream(path, mux, discoveryStart, eventStart),
  });
  mux.addTransformer(transformer);
}

function makeEvent(
  method: string,
  ns: string[] = [],
  data: unknown = {},
  seq = 0
): ProtocolEvent {
  return makeProtocolEvent(method, { namespace: ns, data, seq });
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
    const mux = new StreamMux();
    installSubgraphDiscovery(mux);
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
    root[RESOLVE_VALUES]({ answer: 42 });

    const result = await outputPromise;
    expect(result).toEqual({ answer: 42 });
  });

  it("output rejects when _rejectValues is called", async () => {
    const mux = new StreamMux();
    const root = new GraphRunStream([], mux);

    const outputPromise = root.output;
    root[REJECT_VALUES](new Error("run failed"));

    await expect(outputPromise).rejects.toThrow("run failed");
  });

  it("messages getter returns fallback iterable when not set", () => {
    const mux = new StreamMux();
    const root = new GraphRunStream([], mux);

    const iterable = root.messages;
    expect(typeof iterable[Symbol.asyncIterator]).toBe("function");
  });

  it("messagesFrom replays buffered messages events via addTransformer", async () => {
    const mux = new StreamMux();
    const root = new GraphRunStream([], mux);
    mux.register([], root);

    const ts = Date.now();

    // Push a complete message lifecycle at depth 1 with node attribution
    // before anyone accesses messagesFrom().
    mux.push(["agent:0"], {
      type: "event",
      seq: 0,
      method: "messages" as ProtocolEvent["method"],
      params: { namespace: ["agent:0"], timestamp: ts, node: "agent", data: { event: "message-start" } },
    });
    mux.push(["agent:0"], {
      type: "event",
      seq: 1,
      method: "messages" as ProtocolEvent["method"],
      params: {
        namespace: ["agent:0"],
        timestamp: ts,
        node: "agent",
        data: { event: "content-block-delta", content: { type: "text", text: "hello" } },
      },
    });
    mux.push(["agent:0"], {
      type: "event",
      seq: 2,
      method: "messages" as ProtocolEvent["method"],
      params: { namespace: ["agent:0"], timestamp: ts, node: "agent", data: { event: "message-finish", reason: "stop" } },
    });
    mux.close();

    // Late call — the messages transformer is registered after all events.
    // addTransformer replays buffered events so messagesFrom catches up.
    const filtered = root.messagesFrom("agent");
    const messages: unknown[] = [];
    for await (const msg of filtered) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(1);
    const msg = messages[0] as { text: AsyncIterable<string> & PromiseLike<string> };
    expect(await msg.text).toBe("hello");
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

    root[SET_MESSAGES_ITERABLE](custom);
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

  it("wires StreamChannel projections from extension transformers to the protocol stream", async () => {
    const channel = StreamChannel.remote<{ msg: string }>("custom-ext");

    const extensionFactory = (): StreamTransformer<{
      myChannel: StreamChannel<{ msg: string }>;
    }> => ({
      init: () => ({ myChannel: channel }),
      process(event: ProtocolEvent): boolean {
        if (event.method === "values") {
          channel.push({ msg: "forwarded" });
        }
        return true;
      },
    });

    const source = makeSource([[[], "values", { x: 1 }]]);
    const stream = createGraphRunStream(source, [extensionFactory]);

    const events: ProtocolEvent[] = [];
    for await (const e of stream) {
      events.push(e);
    }

    const channelEvents = events.filter(
      (e) => (e.method as string) === "custom-ext"
    );
    expect(channelEvents).toHaveLength(1);
    expect(channelEvents[0].params.data).toEqual({ msg: "forwarded" });

    expect(stream.extensions).toHaveProperty("myChannel");
  });

  it("keeps local StreamChannel projections in-process only", async () => {
    const channel = StreamChannel.local<{ msg: string }>();

    const extensionFactory = (): StreamTransformer<{
      myChannel: StreamChannel<{ msg: string }>;
    }> => ({
      init: () => ({ myChannel: channel }),
      process(event: ProtocolEvent): boolean {
        if (event.method === "values") {
          channel.push({ msg: "local" });
        }
        return true;
      },
    });

    const source = makeSource([[[], "values", { x: 1 }]]);
    const stream = createGraphRunStream(source, [extensionFactory]);

    const events: ProtocolEvent[] = [];
    for await (const e of stream) {
      events.push(e);
    }

    expect(events.map((e) => e.method)).not.toContain(undefined);
    expect(events.filter((e) => e.params.data === channel)).toHaveLength(0);
    await expect(collect(channel[Symbol.asyncIterator]())).resolves.toEqual([
      { msg: "local" },
    ]);
  });

  it("does NOT wire StreamChannel projections from native transformers", async () => {
    const channel = StreamChannel.remote<{ obj: Promise<number> }>("native-ch");

    const nativeFactory = (): NativeStreamTransformer<{
      nativeProp: StreamChannel<{ obj: Promise<number> }>;
    }> => ({
      __native: true,
      init: () => ({ nativeProp: channel }),
      process(event: ProtocolEvent): boolean {
        if (event.method === "values") {
          channel.push({ obj: Promise.resolve(42) });
        }
        return true;
      },
    });

    const source = makeSource([[[], "values", { x: 1 }]]);
    const stream = createGraphRunStream(source, [nativeFactory]);

    const events: ProtocolEvent[] = [];
    for await (const e of stream) {
      events.push(e);
    }

    const channelEvents = events.filter(
      (e) => (e.method as string) === "native-ch"
    );
    expect(channelEvents).toHaveLength(0);

    expect(stream.extensions).not.toHaveProperty("nativeProp");
  });

  it("native projections are assigned directly to the root stream, not extensions", async () => {
    const nativeFactory = (): NativeStreamTransformer<{
      toolCalls: string[];
    }> => ({
      __native: true,
      init: () => ({ toolCalls: ["call_1"] }),
      process(): boolean {
        return true;
      },
    });

    const source = makeSource([[[], "values", { x: 1 }]]);
    const stream = createGraphRunStream(source, [nativeFactory]);
    await stream.output;

    expect(stream.extensions).not.toHaveProperty("toolCalls");
    expect((stream as unknown as Record<string, unknown>).toolCalls).toEqual([
      "call_1",
    ]);
  });

  it("mixed native and extension transformers: only extension channels are wired", async () => {
    const extChannel = StreamChannel.remote<string>("ext-data");
    const nativeChannel = StreamChannel.remote<string>("native-data");

    const extensionFactory = (): StreamTransformer<{
      extData: StreamChannel<string>;
    }> => ({
      init: () => ({ extData: extChannel }),
      process(event: ProtocolEvent): boolean {
        if (event.method === "values") {
          extChannel.push("ext-item");
        }
        return true;
      },
    });

    const nativeFactory = (): NativeStreamTransformer<{
      nativeData: StreamChannel<string>;
    }> => ({
      __native: true,
      init: () => ({ nativeData: nativeChannel }),
      process(event: ProtocolEvent): boolean {
        if (event.method === "values") {
          nativeChannel.push("native-item");
        }
        return true;
      },
    });

    const source = makeSource([[[], "values", { x: 1 }]]);
    const stream = createGraphRunStream(source, [
      extensionFactory,
      nativeFactory,
    ]);

    const events: ProtocolEvent[] = [];
    for await (const e of stream) {
      events.push(e);
    }

    const extEvents = events.filter(
      (e) => (e.method as string) === "ext-data"
    );
    expect(extEvents).toHaveLength(1);
    expect(extEvents[0].params.data).toBe("ext-item");

    const nativeEvents = events.filter(
      (e) => (e.method as string) === "native-data"
    );
    expect(nativeEvents).toHaveLength(0);
  });
});
