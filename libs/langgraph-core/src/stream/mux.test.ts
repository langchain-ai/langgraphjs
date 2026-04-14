import { describe, expect, it, vi } from "vitest";
import {
  StreamMux,
  pump,
  nsKey,
  hasPrefix,
  RESOLVE_VALUES,
  REJECT_VALUES,
} from "./mux.js";
import type { SubgraphStreamFactory } from "./mux.js";
import { StreamChannel } from "./stream-channel.js";
import type { ProtocolEvent, StreamTransformer } from "./types.js";

class MockSubgraphStream {
  constructor(
    public path: string[],
    public mux: StreamMux,
    public discoveryStart: number,
    public eventStart: number
  ) {}
  [RESOLVE_VALUES](_v: unknown) {}
  [REJECT_VALUES](_e: unknown) {}
}

const mockFactory: SubgraphStreamFactory = (path, mux, discoveryStart, eventStart) =>
  new MockSubgraphStream(path, mux, discoveryStart, eventStart);

function makeEvent(
  method: string,
  ns: string[] = [],
  seq = 0
): ProtocolEvent {
  return {
    type: "event",
    seq,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    method: method as any,
    params: { namespace: ns, timestamp: Date.now(), data: {} },
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

describe("nsKey", () => {
  it("joins segments with null byte", () => {
    expect(nsKey(["a", "b", "c"])).toBe("a\x00b\x00c");
  });

  it("returns empty string for empty namespace", () => {
    expect(nsKey([])).toBe("");
  });

  it("returns the segment itself for single-element namespace", () => {
    expect(nsKey(["root"])).toBe("root");
  });
});

describe("hasPrefix", () => {
  it("returns true for empty prefix", () => {
    expect(hasPrefix(["a", "b"], [])).toBe(true);
  });

  it("returns true for exact match", () => {
    expect(hasPrefix(["a", "b"], ["a", "b"])).toBe(true);
  });

  it("returns true when ns starts with prefix", () => {
    expect(hasPrefix(["a", "b", "c"], ["a", "b"])).toBe(true);
  });

  it("returns false when prefix is longer than ns", () => {
    expect(hasPrefix(["a"], ["a", "b"])).toBe(false);
  });

  it("returns false when segments differ", () => {
    expect(hasPrefix(["a", "b"], ["a", "x"])).toBe(false);
  });

  it("returns true for two empty arrays", () => {
    expect(hasPrefix([], [])).toBe(true);
  });
});

describe("StreamMux", () => {
  it("push creates subgraph discoveries for new namespaces", () => {
    const mux = new StreamMux(mockFactory);
    mux.push(["agent"], makeEvent("messages", ["agent"]));

    const discoveries: unknown[] = [];
    const iter = mux._discoveries.iterate();

    mux._discoveries.close();

    (async () => {
      const items = await collect(iter);
      discoveries.push(...items);
    })();

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(discoveries).toHaveLength(1);
        const d = discoveries[0] as { ns: string[]; stream: MockSubgraphStream };
        expect(d.ns).toEqual(["agent"]);
        expect(d.stream).toBeInstanceOf(MockSubgraphStream);
        resolve();
      }, 10);
    });
  });

  it("push creates discoveries only for top-level namespace segments", () => {
    const mux = new StreamMux(mockFactory);
    mux.push(
      ["parent", "child"],
      makeEvent("messages", ["parent", "child"])
    );
    mux._discoveries.close();

    return collect(mux._discoveries.iterate()).then((items) => {
      expect(items).toHaveLength(1);
      expect(items[0].ns).toEqual(["parent"]);
    });
  });

  it("push does not create duplicate discoveries", () => {
    const mux = new StreamMux(mockFactory);
    mux.push(["agent"], makeEvent("messages", ["agent"], 0));
    mux.push(["agent"], makeEvent("messages", ["agent"], 1));
    mux._discoveries.close();

    return collect(mux._discoveries.iterate()).then((items) => {
      expect(items).toHaveLength(1);
    });
  });

  it("push runs transformer pipeline — events suppressed when transformer returns false", () => {
    const mux = new StreamMux();
    const transformer: StreamTransformer = {
      init: () => ({}),
      process: (event) => event.method !== "debug",
      finalize: () => {},
      fail: () => {},
    };
    mux.addTransformer(transformer);

    mux.push([], makeEvent("messages", [], 0));
    mux.push([], makeEvent("debug", [], 1));
    mux.push([], makeEvent("updates", [], 2));
    mux._events.close();

    return collect(mux._events.iterate()).then((events) => {
      expect(events).toHaveLength(2);
      expect(events[0].method).toBe("messages");
      expect(events[1].method).toBe("updates");
    });
  });

  it("StreamChannel auto-forwards pushes into the main event log", async () => {
    const mux = new StreamMux();
    const channel = new StreamChannel<{ event: string }>("tools");
    const transformer: StreamTransformer = {
      init: () => ({ tools: channel }),
      process: (_event) => {
        if (_event.method === "messages") {
          channel.push({ event: "tool-started", tool_name: "search" } as never);
        }
        return true;
      },
    };
    mux.addTransformer(transformer);
    mux.wireChannels(transformer.init() as Record<string, unknown>);

    mux.push([], makeEvent("messages", [], 0));
    mux._events.close();

    const events = await collect(mux._events.iterate());
    expect(events).toHaveLength(2);
    // Channel-forwarded events appear during process(), before the
    // original event is appended by the mux.
    expect(events[0].method).toBe("tools");
    expect(events[0].params.data).toEqual({
      event: "tool-started",
      tool_name: "search",
    });
    expect(events[1].method).toBe("messages");
  });

  it("StreamChannel auto-forwarded events inherit the triggering namespace", async () => {
    const mux = new StreamMux(mockFactory);
    const channel = new StreamChannel<{ event: string }>("tools");
    const transformer: StreamTransformer = {
      init: () => ({ tools: channel }),
      process: (_event) => {
        channel.push({ event: "tool-started" });
        return true;
      },
    };
    mux.addTransformer(transformer);
    mux.wireChannels(transformer.init() as Record<string, unknown>);

    mux.push(["agent"], makeEvent("messages", ["agent"], 0));
    mux._events.close();

    const events = await collect(mux._events.iterate());
    expect(events[1].params.namespace).toEqual(["agent"]);
  });

  it("StreamChannel auto-forwarded events get sequential seq numbers", async () => {
    const mux = new StreamMux();
    const ch1 = new StreamChannel<unknown>("tools");
    const ch2 = new StreamChannel<unknown>("custom");
    const transformer: StreamTransformer = {
      init: () => ({ ch1, ch2 }),
      process: (_event) => {
        ch1.push({ a: 1 });
        ch2.push({ b: 2 });
        return true;
      },
    };
    mux.addTransformer(transformer);
    mux.wireChannels(transformer.init() as Record<string, unknown>);

    mux.push([], makeEvent("messages", [], 5));
    mux._events.close();

    const events = await collect(mux._events.iterate());
    // Channel events (seq 6, 7) appear before the original (seq 5)
    // because pushes happen during process().
    expect(events[0].seq).toBe(6);
    expect(events[1].seq).toBe(7);
    expect(events[2].seq).toBe(5);
  });

  it("mux auto-closes StreamChannels on close", async () => {
    const mux = new StreamMux();
    const channel = new StreamChannel<number>("stats");
    const transformer: StreamTransformer = {
      init: () => ({ stats: channel }),
      process: (_event) => {
        channel.push(42);
        return true;
      },
    };
    mux.addTransformer(transformer);
    mux.wireChannels(transformer.init() as Record<string, unknown>);

    mux.push([], makeEvent("values", [], 0));
    mux.close();

    const items: number[] = [];
    for await (const item of channel) {
      items.push(item);
    }
    expect(items).toEqual([42]);
  });

  it("mux auto-fails StreamChannels on fail", async () => {
    const mux = new StreamMux();
    const channel = new StreamChannel<number>("stats");
    const transformer: StreamTransformer = {
      init: () => ({ stats: channel }),
      process: () => true,
    };
    mux.addTransformer(transformer);
    mux.wireChannels(transformer.init() as Record<string, unknown>);

    mux.fail(new Error("boom"));

    await expect(async () => {
      for await (const _ of channel) {
        void _;
      }
    }).rejects.toThrow("boom");
  });

  it("addTransformer + process order", () => {
    const mux = new StreamMux();
    const order: number[] = [];

    const makeTransformer = (id: number): StreamTransformer => ({
      init: () => ({}),
      process: () => {
        order.push(id);
        return true;
      },
      finalize: () => {},
      fail: () => {},
    });

    mux.addTransformer(makeTransformer(1));
    mux.addTransformer(makeTransformer(2));
    mux.addTransformer(makeTransformer(3));

    mux.push([], makeEvent("messages"));
    expect(order).toEqual([1, 2, 3]);
  });

  it("close finalizes transformers, closes event and discovery logs", () => {
    const mux = new StreamMux();
    const finalizeSpy = vi.fn();
    const transformer: StreamTransformer = {
      init: () => ({}),
      process: () => true,
      finalize: finalizeSpy,
      fail: () => {},
    };
    mux.addTransformer(transformer);
    mux.close();

    expect(finalizeSpy).toHaveBeenCalledOnce();
    expect(mux._events.done).toBe(true);
    expect(mux._discoveries.done).toBe(true);
  });

  it("close resolves values on registered streams", () => {
    const mux = new StreamMux();
    const mockStream = new MockSubgraphStream([], mux, 0, 0);
    const resolveSpy = vi.spyOn(mockStream, RESOLVE_VALUES);
    mux.register([], mockStream);

    const valuesEvent: ProtocolEvent = {
      type: "event",
      seq: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      method: "values" as any,
      params: {
        namespace: [],
        timestamp: Date.now(),
        data: { count: 42 },
      },
    };
    mux.push([], valuesEvent);
    mux.close();

    expect(resolveSpy).toHaveBeenCalledWith({ count: 42 });
  });

  it("fail calls fail on all transformers, events, discoveries, and streams", () => {
    const mux = new StreamMux();
    const failSpy = vi.fn();
    const transformer: StreamTransformer = {
      init: () => ({}),
      process: () => true,
      finalize: () => {},
      fail: failSpy,
    };
    mux.addTransformer(transformer);

    const mockStream = new MockSubgraphStream([], mux, 0, 0);
    const rejectSpy = vi.spyOn(mockStream, REJECT_VALUES);
    mux.register(["sub"], mockStream);

    const error = new Error("test failure");
    mux.fail(error);

    expect(failSpy).toHaveBeenCalledWith(error);
    expect(mux._events.done).toBe(true);
    expect(mux._discoveries.done).toBe(true);
    expect(rejectSpy).toHaveBeenCalledWith(error);
  });

  it("subscribeEvents filters by namespace prefix", async () => {
    const mux = new StreamMux(mockFactory);

    mux.push([], makeEvent("messages", [], 0));
    mux.push(["agent"], makeEvent("messages", ["agent"], 1));
    mux.push(["agent", "sub"], makeEvent("updates", ["agent", "sub"], 2));
    mux.push(["other"], makeEvent("messages", ["other"], 3));
    mux._events.close();

    const filtered = await collect(mux.subscribeEvents(["agent"]));
    expect(filtered).toHaveLength(2);
    expect(filtered[0].params.namespace).toEqual(["agent"]);
    expect(filtered[1].params.namespace).toEqual(["agent", "sub"]);
  });

  it("subscribeSubgraphs yields only top-level discovered subgraphs", async () => {
    const mux = new StreamMux(mockFactory);

    // Deep namespace — only top-level ["parent"] is announced as a discovery
    mux.push(
      ["parent", "child", "grandchild"],
      makeEvent("messages", ["parent", "child", "grandchild"])
    );
    // Second top-level subgraph
    mux.push(["sibling"], makeEvent("messages", ["sibling"]));
    mux._discoveries.close();

    // Root-level subscription sees both top-level subgraphs
    const rootChildren = await collect(mux.subscribeSubgraphs([]));
    expect(rootChildren).toHaveLength(2);
    expect((rootChildren[0] as MockSubgraphStream).path).toEqual(["parent"]);
    expect((rootChildren[1] as MockSubgraphStream).path).toEqual(["sibling"]);
  });

  it("markInterrupted sets interrupted flag and stores payloads", () => {
    const mux = new StreamMux();
    expect(mux.interrupted).toBe(false);
    expect(mux.interrupts).toEqual([]);

    const payloads = [
      { interruptId: "int-1", payload: { question: "continue?" } },
      { interruptId: "int-2", payload: null },
    ];
    mux.markInterrupted(payloads);

    expect(mux.interrupted).toBe(true);
    expect(mux.interrupts).toEqual(payloads);
  });

  it("markInterrupted accumulates across multiple calls", () => {
    const mux = new StreamMux();
    mux.markInterrupted([{ interruptId: "a", payload: 1 }]);
    mux.markInterrupted([{ interruptId: "b", payload: 2 }]);

    expect(mux.interrupts).toHaveLength(2);
    expect(mux.interrupts[0].interruptId).toBe("a");
    expect(mux.interrupts[1].interruptId).toBe("b");
  });
});

describe("pump", () => {
  it("converts chunks and pushes them, closes on end", async () => {
    const mux = new StreamMux();

    async function* source() {
      yield [[], "messages", { text: "hello" }] as [string[], string, unknown];
      yield [[], "updates", { node: "a" }] as [string[], string, unknown];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await pump(source() as any, mux);

    expect(mux._events.done).toBe(true);
    const events = await collect(mux._events.iterate());
    expect(events).toHaveLength(2);
    expect(events[0].method).toBe("messages");
    expect(events[1].method).toBe("updates");
    expect(events[0].seq).toBe(0);
    expect(events[1].seq).toBe(1);
  });

  it("calls fail on error", async () => {
    const mux = new StreamMux();
    const failError = new Error("stream broke");

    async function* source() {
      yield [[], "messages", {}] as [string[], string, unknown];
      throw failError;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await pump(source() as any, mux);

    expect(mux._events.done).toBe(true);

    const iter = mux._events.iterate();
    await iter.next(); // consume the one valid event
    await expect(iter.next()).rejects.toThrow("stream broke");
  });

  it("skips null events from unrecognised modes", async () => {
    const mux = new StreamMux();

    async function* source() {
      yield [[], "unknown_mode", {}] as [string[], string, unknown];
      yield [[], "messages", { text: "hi" }] as [string[], string, unknown];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await pump(source() as any, mux);

    const events = await collect(mux._events.iterate());
    expect(events).toHaveLength(1);
    expect(events[0].method).toBe("messages");
  });
});
