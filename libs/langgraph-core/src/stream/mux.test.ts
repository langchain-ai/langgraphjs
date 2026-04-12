import { describe, expect, it, vi } from "vitest";
import {
  StreamMux,
  pump,
  nsKey,
  hasPrefix,
  setRunStreamClasses,
} from "./mux.js";
import type { ProtocolEvent, StreamReducer } from "./types.js";

class MockSubgraphStream {
  constructor(
    public path: string[],
    public mux: StreamMux,
    public discoveryStart: number,
    public eventStart: number
  ) {}
  _resolveValues(_v: unknown) {}
  _rejectValues(_e: unknown) {}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
setRunStreamClasses(MockSubgraphStream as any, MockSubgraphStream as any);

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
    const mux = new StreamMux();
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
    const mux = new StreamMux();
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
    const mux = new StreamMux();
    mux.push(["agent"], makeEvent("messages", ["agent"], 0));
    mux.push(["agent"], makeEvent("messages", ["agent"], 1));
    mux._discoveries.close();

    return collect(mux._discoveries.iterate()).then((items) => {
      expect(items).toHaveLength(1);
    });
  });

  it("push runs reducer pipeline — events suppressed when reducer returns false", () => {
    const mux = new StreamMux();
    const reducer: StreamReducer = {
      init: () => ({}),
      process: (event) => event.method !== "debug",
      finalize: () => {},
      fail: () => {},
    };
    mux.addReducer(reducer);

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

  it("emit callback injects events into the main log after the original", async () => {
    const mux = new StreamMux();
    const reducer: StreamReducer = {
      init: () => ({}),
      process: (_event, emit) => {
        if (_event.method === "messages") {
          emit?.("tools", { event: "tool-started", tool_name: "search" });
        }
        return true;
      },
      finalize: () => {},
      fail: () => {},
    };
    mux.addReducer(reducer);

    mux.push([], makeEvent("messages", [], 0));
    mux._events.close();

    const events = await collect(mux._events.iterate());
    expect(events).toHaveLength(2);
    expect(events[0].method).toBe("messages");
    expect(events[1].method).toBe("tools");
    expect(events[1].params.data).toEqual({
      event: "tool-started",
      tool_name: "search",
    });
  });

  it("emit callback can inject multiple events from a single process call", async () => {
    const mux = new StreamMux();
    const reducer: StreamReducer = {
      init: () => ({}),
      process: (_event, emit) => {
        emit?.("lifecycle", { event: "spawned" });
        emit?.("custom", { type: "status", status: "working" });
        return true;
      },
      finalize: () => {},
      fail: () => {},
    };
    mux.addReducer(reducer);

    mux.push([], makeEvent("updates", [], 0));
    mux._events.close();

    const events = await collect(mux._events.iterate());
    expect(events).toHaveLength(3);
    expect(events[0].method).toBe("updates");
    expect(events[1].method).toBe("lifecycle");
    expect(events[2].method).toBe("custom");
  });

  it("emitted events inherit the namespace of the triggering event", async () => {
    const mux = new StreamMux();
    const reducer: StreamReducer = {
      init: () => ({}),
      process: (_event, emit) => {
        emit?.("tools", { event: "tool-started" });
        return true;
      },
      finalize: () => {},
      fail: () => {},
    };
    mux.addReducer(reducer);

    mux.push(["agent"], makeEvent("messages", ["agent"], 0));
    mux._events.close();

    const events = await collect(mux._events.iterate());
    expect(events[1].params.namespace).toEqual(["agent"]);
  });

  it("emitted events get sequential seq numbers", async () => {
    const mux = new StreamMux();
    const reducer: StreamReducer = {
      init: () => ({}),
      process: (_event, emit) => {
        emit?.("tools", { a: 1 });
        emit?.("custom", { b: 2 });
        return true;
      },
      finalize: () => {},
      fail: () => {},
    };
    mux.addReducer(reducer);

    mux.push([], makeEvent("messages", [], 5));
    mux._events.close();

    const events = await collect(mux._events.iterate());
    expect(events[0].seq).toBe(5);
    expect(events[1].seq).toBe(6);
    expect(events[2].seq).toBe(7);
  });

  it("addReducer + process order", () => {
    const mux = new StreamMux();
    const order: number[] = [];

    const makeReducer = (id: number): StreamReducer => ({
      init: () => ({}),
      process: () => {
        order.push(id);
        return true;
      },
      finalize: () => {},
      fail: () => {},
    });

    mux.addReducer(makeReducer(1));
    mux.addReducer(makeReducer(2));
    mux.addReducer(makeReducer(3));

    mux.push([], makeEvent("messages"));
    expect(order).toEqual([1, 2, 3]);
  });

  it("close finalizes reducers, closes event and discovery logs", () => {
    const mux = new StreamMux();
    const finalizeSpy = vi.fn();
    const reducer: StreamReducer = {
      init: () => ({}),
      process: () => true,
      finalize: finalizeSpy,
      fail: () => {},
    };
    mux.addReducer(reducer);
    mux.close();

    expect(finalizeSpy).toHaveBeenCalledOnce();
    expect(mux._events.done).toBe(true);
    expect(mux._discoveries.done).toBe(true);
  });

  it("close resolves values on registered streams", () => {
    const mux = new StreamMux();
    const mockStream = new MockSubgraphStream([], mux, 0, 0);
    const resolveSpy = vi.spyOn(mockStream, "_resolveValues");
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

  it("fail calls fail on all reducers, events, discoveries, and streams", () => {
    const mux = new StreamMux();
    const failSpy = vi.fn();
    const reducer: StreamReducer = {
      init: () => ({}),
      process: () => true,
      finalize: () => {},
      fail: failSpy,
    };
    mux.addReducer(reducer);

    const mockStream = new MockSubgraphStream([], mux, 0, 0);
    const rejectSpy = vi.spyOn(mockStream, "_rejectValues");
    mux.register(["sub"], mockStream);

    const error = new Error("test failure");
    mux.fail(error);

    expect(failSpy).toHaveBeenCalledWith(error, expect.any(Function));
    expect(mux._events.done).toBe(true);
    expect(mux._discoveries.done).toBe(true);
    expect(rejectSpy).toHaveBeenCalledWith(error);
  });

  it("subscribeEvents filters by namespace prefix", async () => {
    const mux = new StreamMux();

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
    const mux = new StreamMux();

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
