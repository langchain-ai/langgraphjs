import { describe, expect, it, vi } from "vitest";
import {
  StreamMux,
  pump,
  nsKey,
  hasPrefix,
  RESOLVE_VALUES,
  REJECT_VALUES,
} from "./mux.js";
import { StreamChannel } from "./stream-channel.js";
import {
  collectIterator as collect,
  makeProtocolEvent,
} from "./test-utils.js";
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

function makeEvent(
  method: string,
  ns: string[] = [],
  seq = 0
): ProtocolEvent {
  return makeProtocolEvent(method, { namespace: ns, seq });
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
    const channel = StreamChannel.remote<{ event: string }>("tools");
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

  it("local StreamChannels are tracked but not auto-forwarded", async () => {
    const mux = new StreamMux();
    const channel = StreamChannel.local<{ event: string }>();
    const transformer: StreamTransformer = {
      init: () => ({ tools: channel }),
      process: (_event) => {
        if (_event.method === "messages") {
          channel.push({ event: "tool-started" });
        }
        return true;
      },
    };
    mux.addTransformer(transformer);
    mux.wireChannels(transformer.init() as Record<string, unknown>);

    mux.push([], makeEvent("messages", [], 0));
    mux.close();

    const events = await collect(mux._events.iterate());
    expect(events).toHaveLength(1);
    expect(events[0].method).toBe("messages");
    await expect(collect(channel[Symbol.asyncIterator]())).resolves.toEqual([
      { event: "tool-started" },
    ]);
  });

  it("StreamChannel auto-forwarded events inherit the triggering namespace", async () => {
    const mux = new StreamMux();
    const channel = StreamChannel.remote<{ event: string }>("tools");
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
    const ch1 = StreamChannel.remote<unknown>("tools");
    const ch2 = StreamChannel.remote<unknown>("custom");
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
    // Channel events appear before the original event because pushes
    // happen during process().  The mux re-stamps every event with
    // its monotonic counter so the log is always strictly increasing.
    expect(events.map((e) => e.method)).toEqual([
      "tools",
      "custom",
      "messages",
    ]);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
    }
  });

  it("mux auto-closes StreamChannels on close", async () => {
    const mux = new StreamMux();
    const channel = StreamChannel.remote<number>("stats");
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
    const channel = StreamChannel.remote<number>("stats");
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

  it("final-value projections flush as custom:<key> events on close", async () => {
    const mux = new StreamMux();
    let resolveToolCallCount!: (value: number) => void;
    const toolCallCount = new Promise<number>((r) => {
      resolveToolCallCount = r;
    });

    const projection = { toolCallCount };
    const transformer: StreamTransformer = {
      init: () => projection,
      process: () => true,
      finalize: () => resolveToolCallCount(7),
    };
    mux.addTransformer(transformer);
    mux.wireChannels(projection);

    mux.close();

    const events = await collect(mux._events.iterate());
    expect(events).toHaveLength(1);
    expect(events[0].method).toBe("custom");
    expect(events[0].params.data).toEqual({
      name: "toolCallCount",
      payload: 7,
    });
    expect(mux._events.done).toBe(true);
    expect(mux._discoveries.done).toBe(true);
  });

  it("uses the projection key as the custom event name", async () => {
    const mux = new StreamMux();
    let resolveA!: (value: unknown) => void;
    let resolveB!: (value: unknown) => void;
    const projection = {
      alpha: new Promise<number>((r) => {
        resolveA = r as (v: unknown) => void;
      }),
      beta: new Promise<string>((r) => {
        resolveB = r as (v: unknown) => void;
      }),
    };
    mux.addTransformer({
      init: () => projection,
      process: () => true,
      finalize: () => {
        resolveA(1);
        resolveB("two");
      },
    });
    mux.wireChannels(projection);
    mux.close();

    const events = await collect(mux._events.iterate());
    const names = events.map((e) => (e.params.data as { name: string }).name);
    expect(names.sort()).toEqual(["alpha", "beta"]);
  });

  it("rejected final-value promises are dropped and do not block close", async () => {
    const mux = new StreamMux();
    let rejectFailing!: (err: unknown) => void;
    let resolveFine!: (value: number) => void;
    const projection = {
      failing: new Promise<number>((_, reject) => {
        rejectFailing = reject;
      }),
      fine: new Promise<number>((r) => {
        resolveFine = r;
      }),
    };
    mux.addTransformer({
      init: () => projection,
      process: () => true,
      finalize: () => {
        rejectFailing(new Error("nope"));
        resolveFine(42);
      },
    });
    mux.wireChannels(projection);
    mux.close();

    const events = await collect(mux._events.iterate());
    expect(events).toHaveLength(1);
    expect(events[0].params.data).toEqual({ name: "fine", payload: 42 });
    expect(mux._events.done).toBe(true);
  });

  it("ignores non-StreamChannel / non-Promise projection values", async () => {
    const mux = new StreamMux();
    const projection = {
      plain: 42,
      nested: { foo: "bar" },
      fn: () => 1,
    };
    mux.addTransformer({
      init: () => projection,
      process: () => true,
    });
    mux.wireChannels(projection);
    mux.close();

    const events = await collect(mux._events.iterate());
    expect(events).toHaveLength(0);
    expect(mux._events.done).toBe(true);
  });

  it("StreamChannel and Promise projections coexist in one transformer", async () => {
    const mux = new StreamMux();
    const activity = StreamChannel.remote<{ event: string }>("activity");
    let resolveCount!: (value: number) => void;
    const projection = {
      activity,
      count: new Promise<number>((r) => {
        resolveCount = r;
      }),
    };
    mux.addTransformer({
      init: () => projection,
      process: () => {
        activity.push({ event: "tool-started" });
        return true;
      },
      finalize: () => resolveCount(3),
    });
    mux.wireChannels(projection);

    mux.push([], makeEvent("messages", [], 0));
    mux.close();

    const events = await collect(mux._events.iterate());
    const methods = events.map((e) => e.method);
    expect(methods).toContain("activity");
    expect(methods).toContain("custom");
    const finalEvent = events.find(
      (e) =>
        e.method === "custom" &&
        (e.params.data as { name?: string }).name === "count"
    );
    expect(finalEvent).toBeDefined();
    expect((finalEvent!.params.data as { payload: number }).payload).toBe(3);
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

  it("addTransformer replays buffered events to the new transformer", () => {
    const mux = new StreamMux();
    mux.push([], makeEvent("messages", [], 0));
    mux.push([], makeEvent("updates", [], 1));
    mux.push([], makeEvent("values", [], 2));

    const replayedMethods: string[] = [];
    const lateTransformer: StreamTransformer = {
      init: () => ({}),
      process: (event) => {
        replayedMethods.push(event.method);
        return true;
      },
    };

    mux.addTransformer(lateTransformer);

    expect(replayedMethods).toEqual(["messages", "updates", "values"]);
  });

  it("addTransformer replays then processes future events", () => {
    const mux = new StreamMux();
    mux.push([], makeEvent("messages", [], 0));

    const processedMethods: string[] = [];
    const lateTransformer: StreamTransformer = {
      init: () => ({}),
      process: (event) => {
        processedMethods.push(event.method);
        return true;
      },
    };

    mux.addTransformer(lateTransformer);
    expect(processedMethods).toEqual(["messages"]);

    mux.push([], makeEvent("updates", [], 1));
    expect(processedMethods).toEqual(["messages", "updates"]);
  });

  it("addTransformer calls finalize if mux already closed", () => {
    const mux = new StreamMux();
    mux.push([], makeEvent("messages", [], 0));
    mux.close();

    const finalized = vi.fn();
    const lateTransformer: StreamTransformer = {
      init: () => ({}),
      process: () => true,
      finalize: finalized,
    };

    mux.addTransformer(lateTransformer);
    expect(finalized).toHaveBeenCalledOnce();
  });

  it("addTransformer calls fail if mux already failed", () => {
    const mux = new StreamMux();
    mux.push([], makeEvent("messages", [], 0));
    const error = new Error("run failed");
    mux.fail(error);

    const failSpy = vi.fn();
    const lateTransformer: StreamTransformer = {
      init: () => ({}),
      process: () => true,
      fail: failSpy,
    };

    mux.addTransformer(lateTransformer);
    expect(failSpy).toHaveBeenCalledWith(error);
  });

  it("addTransformer replays only events buffered before registration", () => {
    const mux = new StreamMux();
    mux.push([], makeEvent("messages", [], 0));
    mux.push([], makeEvent("values", [], 1));

    const replayedSeqs: number[] = [];
    const lateTransformer: StreamTransformer = {
      init: () => ({}),
      process: (event) => {
        replayedSeqs.push(event.seq);
        return true;
      },
    };

    // Suppress one of the events to ensure we replay from the log
    // (which only contains kept events), not from the raw push history.
    const suppressDebug: StreamTransformer = {
      init: () => ({}),
      process: (event) => event.method !== "debug",
    };
    mux.addTransformer(suppressDebug);
    mux.push([], makeEvent("debug", [], 2));
    mux.push([], makeEvent("updates", [], 3));

    mux.addTransformer(lateTransformer);

    // Late transformer sees all events that made it into the log
    // (messages, values, updates — debug was suppressed).  The mux
    // re-stamps seq at append time, so the replayed sequence is the
    // monotonic log order.
    expect(replayedSeqs).toEqual([0, 1, 2]);
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
