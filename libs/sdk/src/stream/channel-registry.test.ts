import { describe, expect, it, vi } from "vitest";
import type { Channel } from "@langchain/protocol";

import { ChannelRegistry } from "./channel-registry.js";
import { StreamStore } from "./store.js";
import type {
  ProjectionRuntime,
  ProjectionSpec,
  RootEventBus,
  ThreadStream,
} from "./types.js";

interface ProjectionTrace {
  opens: number;
  disposes: number;
  threads: Array<ThreadStream | undefined>;
  stores: Array<StreamStore<string>>;
}

function makeRootBus(): RootEventBus {
  return {
    channels: [] as readonly Channel[],
    subscribe: vi.fn(() => () => undefined),
  };
}

function makeThread(name = "thread"): ThreadStream {
  return { __name: name } as unknown as ThreadStream;
}

function makeSpec(
  key: string,
  initial: string,
  trace: ProjectionTrace,
  options: { disposeImpl?: () => Promise<void> | void } = {}
): ProjectionSpec<string> {
  return {
    key,
    namespace: [],
    initial,
    open: ({ thread, store }): ProjectionRuntime => {
      trace.opens += 1;
      trace.threads.push(thread);
      trace.stores.push(store);
      return {
        dispose: async () => {
          trace.disposes += 1;
          if (options.disposeImpl) await options.disposeImpl();
        },
      };
    },
  };
}

function makeTrace(): ProjectionTrace {
  return { opens: 0, disposes: 0, threads: [], stores: [] };
}

describe("ChannelRegistry", () => {
  it("does not open a runtime until a thread is bound", () => {
    const registry = new ChannelRegistry(makeRootBus());
    const trace = makeTrace();
    const handle = registry.acquire(makeSpec("k", "init", trace));

    expect(trace.opens).toBe(0);
    expect(handle.store.getSnapshot()).toBe("init");
  });

  it("opens the runtime exactly once even when multiple consumers acquire", () => {
    const bus = makeRootBus();
    const registry = new ChannelRegistry(bus);
    const trace = makeTrace();
    const thread = makeThread();
    registry.bind(thread);

    const a = registry.acquire(makeSpec("k", "init", trace));
    const b = registry.acquire(makeSpec("k", "init", trace));

    expect(trace.opens).toBe(1);
    expect(a.store).toBe(b.store);
    expect(registry.size).toBe(1);
    expect(trace.threads[0]).toBe(thread);
  });

  it("disposes the runtime only after the last consumer releases", () => {
    const registry = new ChannelRegistry(makeRootBus());
    const trace = makeTrace();
    registry.bind(makeThread());

    const a = registry.acquire(makeSpec("k", "init", trace));
    const b = registry.acquire(makeSpec("k", "init", trace));

    a.release();
    expect(trace.disposes).toBe(0);
    expect(registry.size).toBe(1);

    b.release();
    expect(trace.disposes).toBe(1);
    expect(registry.size).toBe(0);
  });

  it("treats double release as a no-op", () => {
    const registry = new ChannelRegistry(makeRootBus());
    const trace = makeTrace();
    registry.bind(makeThread());

    const a = registry.acquire(makeSpec("k", "init", trace));
    a.release();
    a.release();

    // Second release must not crash and must not double-decrement.
    expect(trace.disposes).toBe(1);
    expect(registry.size).toBe(0);
  });

  it("opens the runtime when bind happens after acquire", () => {
    const registry = new ChannelRegistry(makeRootBus());
    const trace = makeTrace();
    const handle = registry.acquire(makeSpec("k", "init", trace));
    expect(trace.opens).toBe(0);

    const thread = makeThread("late");
    registry.bind(thread);

    expect(trace.opens).toBe(1);
    expect(trace.threads[0]).toBe(thread);
    // Store identity is preserved across the bind.
    expect(handle.store.getSnapshot()).toBe("init");
  });

  it("rebinds existing entries to the new thread, resetting stores to initial", async () => {
    const registry = new ChannelRegistry(makeRootBus());
    const trace = makeTrace();
    const t1 = makeThread("t1");
    registry.bind(t1);

    const handle = registry.acquire(makeSpec("k", "init", trace));
    handle.store.setValue("evolved");
    expect(handle.store.getSnapshot()).toBe("evolved");

    const t2 = makeThread("t2");
    registry.bind(t2);

    // Wait a microtask for the async dispose to flush.
    await Promise.resolve();

    expect(trace.opens).toBe(2);
    expect(trace.disposes).toBe(1);
    expect(trace.threads.at(-1)).toBe(t2);
    // Store identity preserved, value reset to initial.
    expect(handle.store.getSnapshot()).toBe("init");
  });

  it("detaches every entry on bind(undefined) without disposing the entry record", async () => {
    const registry = new ChannelRegistry(makeRootBus());
    const trace = makeTrace();
    registry.bind(makeThread());
    registry.acquire(makeSpec("k", "init", trace));
    expect(trace.opens).toBe(1);

    registry.bind(undefined);
    await Promise.resolve();

    expect(trace.disposes).toBe(1);
    expect(registry.size).toBe(1); // entry still tracked, just not running
    expect(registry.thread).toBeUndefined();
  });

  it("treats bind(sameThread) as a no-op", async () => {
    const registry = new ChannelRegistry(makeRootBus());
    const trace = makeTrace();
    const thread = makeThread();
    registry.bind(thread);
    registry.acquire(makeSpec("k", "init", trace));

    registry.bind(thread);
    await Promise.resolve();

    // No re-open, no dispose churn.
    expect(trace.opens).toBe(1);
    expect(trace.disposes).toBe(0);
  });

  it("isolates entries with different keys", () => {
    const registry = new ChannelRegistry(makeRootBus());
    const traceA = makeTrace();
    const traceB = makeTrace();
    registry.bind(makeThread());

    const a = registry.acquire(makeSpec("a", "A0", traceA));
    const b = registry.acquire(makeSpec("b", "B0", traceB));

    expect(a.store).not.toBe(b.store);
    expect(traceA.opens).toBe(1);
    expect(traceB.opens).toBe(1);
    expect(registry.size).toBe(2);
  });

  it("dispose() tears down every entry and detaches the thread", async () => {
    const registry = new ChannelRegistry(makeRootBus());
    const trace = makeTrace();
    registry.bind(makeThread());
    registry.acquire(makeSpec("a", "init", trace));
    registry.acquire(makeSpec("b", "init", trace));

    await registry.dispose();

    expect(trace.disposes).toBe(2);
    expect(registry.size).toBe(0);
    expect(registry.thread).toBeUndefined();
  });

  it("dispose() is idempotent", async () => {
    const registry = new ChannelRegistry(makeRootBus());
    await registry.dispose();
    await registry.dispose();
    expect(registry.size).toBe(0);
  });

  it("swallows errors thrown by a misbehaving runtime.dispose()", async () => {
    const registry = new ChannelRegistry(makeRootBus());
    const trace = makeTrace();
    registry.bind(makeThread());
    const spec = makeSpec("k", "init", trace, {
      disposeImpl: () => {
        throw new Error("boom");
      },
    });

    const handle = registry.acquire(spec);

    // Releasing the misbehaving runtime must not throw out to the caller.
    expect(() => handle.release()).not.toThrow();
    // Give the swallowed promise rejection a tick to flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(registry.size).toBe(0);
  });

  it("forwards the rootBus to projection.open()", () => {
    const bus = makeRootBus();
    const registry = new ChannelRegistry(bus);
    const trace = makeTrace();
    registry.bind(makeThread());

    let receivedBus: RootEventBus | undefined;
    registry.acquire({
      key: "k",
      namespace: [],
      initial: "init",
      open: ({ rootBus }) => {
        receivedBus = rootBus;
        trace.opens += 1;
        return { dispose: () => undefined };
      },
    });

    expect(receivedBus).toBe(bus);
  });
});
