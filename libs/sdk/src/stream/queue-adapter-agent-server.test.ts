import { describe, expect, it, vi } from "vitest";

import { EMPTY_QUEUE, type ServerQueueCapability, type SubmissionQueueSnapshot } from "./queue-adapter.js";
import { AgentServerQueueAdapter } from "./queue-adapter-agent-server.js";
import { StreamStore } from "./store.js";
import type { ThreadStream } from "../client/index.js";

interface State {
  count?: number;
}

function makeStore(): StreamStore<SubmissionQueueSnapshot<State>> {
  return new StreamStore<SubmissionQueueSnapshot<State>>(
    EMPTY_QUEUE as SubmissionQueueSnapshot<State>
  );
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A minimal fake Runs client + thread-event emitter shared across tests. */
function makeFakeBackend() {
  const runs: { create: unknown; list: unknown; cancel: unknown } = {
    create: vi.fn(),
    list: vi.fn(async () => []),
    cancel: vi.fn(async () => undefined),
  };
  const listeners = new Set<(event: unknown) => void>();
  const getThread = vi.fn(() => ({
    onEvent: (listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  })) as unknown as (threadId: string) => Pick<ThreadStream, "onEvent">;
  // The root run's own initial transition is reported as "running", not
  // "started" ("started" is reserved for subgraph-hierarchy discovery and
  // never fires for the root namespace).
  const emitStarted = () => {
    for (const l of listeners)
      l({ method: "lifecycle", params: { data: { event: "running" } } });
  };
  return { runs: runs as unknown as ServerQueueCapability, getThread, emitStarted, listeners };
}

describe("AgentServerQueueAdapter", () => {
  it("enqueue creates a real run immediately and reconciles the optimistic entry with its run id", async () => {
    const { runs, getThread } = makeFakeBackend();
    (runs.create as ReturnType<typeof vi.fn>).mockResolvedValue({ run_id: "run-1" });
    const store = makeStore();
    const adapter = new AgentServerQueueAdapter<State>(
      runs,
      "assistant-1",
      store,
      vi.fn(),
      getThread
    );

    await adapter.enqueue("thread-1", { count: 1 }, undefined);

    expect(runs.create).toHaveBeenCalledWith(
      "thread-1",
      "assistant-1",
      expect.objectContaining({ multitaskStrategy: "enqueue" })
    );
    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0].runId).toBe("run-1");
  });

  it("rolls back the optimistic entry and reports the error when create() fails", async () => {
    const { runs, getThread } = makeFakeBackend();
    const boom = new Error("network down");
    (runs.create as ReturnType<typeof vi.fn>).mockRejectedValue(boom);
    const store = makeStore();
    const onError = vi.fn();
    const adapter = new AgentServerQueueAdapter<State>(
      runs,
      "assistant-1",
      store,
      onError,
      getThread
    );

    await expect(
      adapter.enqueue("thread-1", { count: 1 }, undefined)
    ).rejects.toThrow(boom);

    expect(store.getSnapshot()).toHaveLength(0);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("cancelling an already-accepted entry calls runs.cancel", async () => {
    const { runs, getThread } = makeFakeBackend();
    (runs.create as ReturnType<typeof vi.fn>).mockResolvedValue({ run_id: "run-1" });
    const store = makeStore();
    const adapter = new AgentServerQueueAdapter<State>(
      runs,
      "assistant-1",
      store,
      vi.fn(),
      getThread
    );
    await adapter.enqueue("thread-1", { count: 1 }, undefined);
    const id = store.getSnapshot()[0].id;

    const removed = await adapter.cancel(id);

    expect(removed).toBe(true);
    expect(runs.cancel).toHaveBeenCalledWith("thread-1", "run-1");
    expect(store.getSnapshot()).toHaveLength(0);
  });

  it("cancelling an entry whose create() is still in flight doesn't call runs.cancel yet, then cancels the run once it lands instead of resurrecting it", async () => {
    const { runs, getThread } = makeFakeBackend();
    const createDeferred = deferred<{ run_id: string }>();
    (runs.create as ReturnType<typeof vi.fn>).mockReturnValue(createDeferred.promise);
    const store = makeStore();
    const adapter = new AgentServerQueueAdapter<State>(
      runs,
      "assistant-1",
      store,
      vi.fn(),
      getThread
    );

    const enqueuePromise = adapter.enqueue("thread-1", { count: 1 }, undefined);
    const id = store.getSnapshot()[0].id;

    const removed = await adapter.cancel(id);
    expect(removed).toBe(true);
    expect(runs.cancel).not.toHaveBeenCalled(); // no runId yet, nothing real to cancel server-side

    createDeferred.resolve({ run_id: "run-1" });
    await enqueuePromise;

    // The run landed after cancellation, so it must be canceled for real now,
    // not silently resurrected into the queue.
    expect(runs.cancel).toHaveBeenCalledWith("thread-1", "run-1");
    expect(store.getSnapshot()).toHaveLength(0);
  });

  it("clear() cancels every entry, including ones still being created", async () => {
    const { runs, getThread } = makeFakeBackend();
    (runs.create as ReturnType<typeof vi.fn>).mockResolvedValue({ run_id: "run-1" });
    const store = makeStore();
    const adapter = new AgentServerQueueAdapter<State>(
      runs,
      "assistant-1",
      store,
      vi.fn(),
      getThread
    );
    await adapter.enqueue("thread-1", { count: 1 }, undefined);
    await adapter.enqueue("thread-1", { count: 2 }, undefined);

    await adapter.clear();

    expect(store.getSnapshot()).toHaveLength(0);
    expect(runs.cancel).toHaveBeenCalledTimes(2);
  });

  it("hydrate populates from runs.list and keeps local entries not yet reflected server-side", async () => {
    const { runs, getThread } = makeFakeBackend();
    (runs.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { run_id: "run-1", created_at: new Date().toISOString(), kwargs: { input: { count: 9 } } },
    ]);
    const store = makeStore();
    // A locally-enqueued entry whose create() hasn't resolved yet.
    store.setState(() => [
      { id: "local-1", values: { count: 1 }, createdAt: new Date() },
    ]);
    const adapter = new AgentServerQueueAdapter<State>(
      runs,
      "assistant-1",
      store,
      vi.fn(),
      getThread
    );

    await adapter.hydrate("thread-1");

    const snapshot = store.getSnapshot();
    expect(snapshot).toHaveLength(2);
    expect(snapshot.find((e) => e.runId === "run-1")?.values).toEqual({ count: 9 });
    expect(snapshot.find((e) => e.id === "local-1")).toBeDefined();
  });

  it("hydrate does not replace an already-confirmed local entry's identity when it's also reported pending remotely", async () => {
    const { runs, getThread } = makeFakeBackend();
    (runs.create as ReturnType<typeof vi.fn>).mockResolvedValue({ run_id: "run-1" });
    const store = makeStore();
    const adapter = new AgentServerQueueAdapter<State>(
      runs,
      "assistant-1",
      store,
      vi.fn(),
      getThread
    );
    await adapter.enqueue("thread-1", { count: 1 }, undefined);
    const originalId = store.getSnapshot()[0].id; // a consumer may already be keying UI (e.g. a cancel button) on this

    (runs.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { run_id: "run-1", created_at: new Date().toISOString() },
    ]);
    await adapter.hydrate("thread-1");

    const snapshot = store.getSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].id).toBe(originalId); // must not be replaced with run_id
    expect(snapshot[0].values).toEqual({ count: 1 }); // must not be replaced with the (empty) Run reconstruction
  });

  it("a stale hydrate() response doesn't clobber a newer one after a rapid thread-switch", async () => {
    const { runs, getThread } = makeFakeBackend();
    const firstList = deferred<Array<{ run_id: string; created_at: string }>>();
    const listMock = runs.list as ReturnType<typeof vi.fn>;
    listMock.mockReturnValueOnce(firstList.promise);
    listMock.mockResolvedValueOnce([
      { run_id: "run-b", created_at: new Date().toISOString() },
    ]);
    const store = makeStore();
    const adapter = new AgentServerQueueAdapter<State>(
      runs,
      "assistant-1",
      store,
      vi.fn(),
      getThread
    );

    const firstHydrate = adapter.hydrate("thread-a"); // slow, resolves after the second
    await adapter.hydrate("thread-b"); // fast, lands first
    expect(store.getSnapshot().map((e) => e.runId)).toEqual(["run-b"]);

    firstList.resolve([{ run_id: "run-a", created_at: new Date().toISOString() }]);
    await firstHydrate;

    // The stale thread-a response must not have overwritten thread-b's state.
    expect(store.getSnapshot().map((e) => e.runId)).toEqual(["run-b"]);
  });

  it("pops an entry once a lifecycle 'running' event arrives and runs.list no longer reports it pending", async () => {
    const { runs, getThread, emitStarted } = makeFakeBackend();
    (runs.create as ReturnType<typeof vi.fn>).mockResolvedValue({ run_id: "run-1" });
    const listMock = runs.list as ReturnType<typeof vi.fn>;
    listMock.mockResolvedValue([]); // run-1 has started, no longer pending
    const store = makeStore();
    const adapter = new AgentServerQueueAdapter<State>(
      runs,
      "assistant-1",
      store,
      vi.fn(),
      getThread
    );
    await adapter.enqueue("thread-1", { count: 1 }, undefined);
    expect(store.getSnapshot()).toHaveLength(1);

    emitStarted();
    await vi.waitFor(() => expect(store.getSnapshot()).toHaveLength(0));
  });

  it("opens exactly one thread subscription no matter how many entries are tracked", async () => {
    const { runs, getThread } = makeFakeBackend();
    (runs.create as ReturnType<typeof vi.fn>).mockResolvedValue({ run_id: "run-1" });
    const store = makeStore();
    const adapter = new AgentServerQueueAdapter<State>(
      runs,
      "assistant-1",
      store,
      vi.fn(),
      getThread
    );

    await adapter.enqueue("thread-1", { count: 1 }, undefined);
    await adapter.enqueue("thread-1", { count: 2 }, undefined);
    await adapter.hydrate("thread-1");

    expect(getThread).toHaveBeenCalledTimes(1);
  });

  it("detach() releases the subscription and resets local state", async () => {
    const { runs, getThread, listeners } = makeFakeBackend();
    (runs.create as ReturnType<typeof vi.fn>).mockResolvedValue({ run_id: "run-1" });
    const store = makeStore();
    const adapter = new AgentServerQueueAdapter<State>(
      runs,
      "assistant-1",
      store,
      vi.fn(),
      getThread
    );
    await adapter.enqueue("thread-1", { count: 1 }, undefined);
    expect(listeners.size).toBe(1);

    adapter.detach();

    expect(listeners.size).toBe(0);
    // A subsequent enqueue on a new thread must re-subscribe, not silently no-op.
    await adapter.enqueue("thread-2", { count: 2 }, undefined);
    expect(listeners.size).toBe(1);
  });

  it("enqueue binds thread_id into config and forwards metadata / forkFrom", async () => {
    const { runs, getThread } = makeFakeBackend();
    (runs.create as ReturnType<typeof vi.fn>).mockResolvedValue({ run_id: "run-1" });
    const store = makeStore();
    const adapter = new AgentServerQueueAdapter<State>(
      runs,
      "assistant-1",
      store,
      vi.fn(),
      getThread
    );

    await adapter.enqueue("thread-1", { count: 1 }, {
      config: { configurable: { foo: "bar" } },
      metadata: { source: "test" },
      forkFrom: "checkpoint-1",
    });

    expect(runs.create).toHaveBeenCalledWith(
      "thread-1",
      "assistant-1",
      expect.objectContaining({
        config: { configurable: { foo: "bar", thread_id: "thread-1" } },
        metadata: { source: "test" },
        checkpointId: "checkpoint-1",
      })
    );
  });

  it("hydrate() passes an AbortSignal to runs.list and does not report an error once detach() supersedes it", async () => {
    const { runs, getThread } = makeFakeBackend();
    const listDeferred = deferred<Array<{ run_id: string; created_at: string }>>();
    const listMock = runs.list as ReturnType<typeof vi.fn>;
    listMock.mockReturnValueOnce(listDeferred.promise);
    const store = makeStore();
    const onError = vi.fn();
    const adapter = new AgentServerQueueAdapter<State>(
      runs,
      "assistant-1",
      store,
      onError,
      getThread
    );

    const hydratePromise = adapter.hydrate("thread-1");
    expect(listMock).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );

    adapter.detach(); // supersedes the in-flight hydrate()
    listDeferred.reject(new Error("aborted"));
    await hydratePromise;

    expect(onError).not.toHaveBeenCalled();
  });

  it("#refreshPending retries once after a failure before giving up", async () => {
    vi.useFakeTimers();
    try {
      const { runs, getThread, emitStarted } = makeFakeBackend();
      (runs.create as ReturnType<typeof vi.fn>).mockResolvedValue({ run_id: "run-1" });
      const listMock = runs.list as ReturnType<typeof vi.fn>;
      const boom = new Error("network blip");
      listMock.mockRejectedValueOnce(boom).mockResolvedValueOnce([]);
      const store = makeStore();
      const onError = vi.fn();
      const adapter = new AgentServerQueueAdapter<State>(
        runs,
        "assistant-1",
        store,
        onError,
        getThread
      );
      await adapter.enqueue("thread-1", { count: 1 }, undefined);

      emitStarted();
      await vi.advanceTimersByTimeAsync(2000); // let the single retry fire

      expect(listMock).toHaveBeenCalledTimes(2); // initial attempt + one retry
      expect(onError).not.toHaveBeenCalled();
      expect(store.getSnapshot()).toHaveLength(0); // retry succeeded, run-1 is no longer pending
    } finally {
      vi.useRealTimers();
    }
  });

  it("#refreshPending reports an error once its retry also fails", async () => {
    vi.useFakeTimers();
    try {
      const { runs, getThread, emitStarted } = makeFakeBackend();
      (runs.create as ReturnType<typeof vi.fn>).mockResolvedValue({ run_id: "run-1" });
      const boom = new Error("network still down");
      (runs.list as ReturnType<typeof vi.fn>).mockRejectedValue(boom);
      const store = makeStore();
      const onError = vi.fn();
      const adapter = new AgentServerQueueAdapter<State>(
        runs,
        "assistant-1",
        store,
        onError,
        getThread
      );
      await adapter.enqueue("thread-1", { count: 1 }, undefined);

      emitStarted();
      await vi.advanceTimersByTimeAsync(2000);

      expect(onError).toHaveBeenCalledWith(boom);
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("detach() cancels a pending #refreshPending retry so it can't land against a later thread", async () => {
    vi.useFakeTimers();
    try {
      const { runs, getThread, emitStarted } = makeFakeBackend();
      (runs.create as ReturnType<typeof vi.fn>).mockResolvedValue({ run_id: "run-1" });
      const listMock = runs.list as ReturnType<typeof vi.fn>;
      listMock.mockRejectedValueOnce(new Error("blip")); // schedules a retry
      const store = makeStore();
      const onError = vi.fn();
      const adapter = new AgentServerQueueAdapter<State>(
        runs,
        "assistant-1",
        store,
        onError,
        getThread
      );
      await adapter.enqueue("thread-1", { count: 1 }, undefined);

      emitStarted();
      await vi.advanceTimersByTimeAsync(0); // let the failed attempt land, retry now scheduled

      adapter.detach(); // must cancel the pending retry
      listMock.mockResolvedValue([
        { run_id: "run-2", created_at: new Date().toISOString() },
      ]);
      await adapter.hydrate("thread-2");
      const callsBeforeWait = listMock.mock.calls.length;

      await vi.advanceTimersByTimeAsync(2000); // the cancelled retry must not fire

      expect(listMock.mock.calls.length).toBe(callsBeforeWait);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("#refreshPending doesn't call runs.list when the queue is already empty", async () => {
    const { runs, getThread, emitStarted } = makeFakeBackend();
    (runs.create as ReturnType<typeof vi.fn>).mockResolvedValue({ run_id: "run-1" });
    const store = makeStore();
    const adapter = new AgentServerQueueAdapter<State>(
      runs,
      "assistant-1",
      store,
      vi.fn(),
      getThread
    );
    await adapter.enqueue("thread-1", { count: 1 }, undefined);
    const id = store.getSnapshot()[0].id;
    await adapter.cancel(id); // empties the queue before the event fires
    (runs.list as ReturnType<typeof vi.fn>).mockClear();

    emitStarted();

    expect(runs.list).not.toHaveBeenCalled();
  });

  it("clear() attempts every cancel even if one fails, and reports the single failure directly", async () => {
    const { runs, getThread } = makeFakeBackend();
    (runs.create as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ run_id: "run-1" })
      .mockResolvedValueOnce({ run_id: "run-2" });
    const boom = new Error("cancel 1 failed");
    (runs.cancel as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(boom)
      .mockResolvedValueOnce(undefined);
    const store = makeStore();
    const onError = vi.fn();
    const adapter = new AgentServerQueueAdapter<State>(
      runs,
      "assistant-1",
      store,
      onError,
      getThread
    );
    await adapter.enqueue("thread-1", { count: 1 }, undefined);
    await adapter.enqueue("thread-1", { count: 2 }, undefined);

    await adapter.clear();

    expect(runs.cancel).toHaveBeenCalledTimes(2); // both attempted despite the first failing
    expect(store.getSnapshot()).toHaveLength(0);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("clear() aggregates multiple cancel failures into a single AggregateError", async () => {
    const { runs, getThread } = makeFakeBackend();
    (runs.create as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ run_id: "run-1" })
      .mockResolvedValueOnce({ run_id: "run-2" });
    const boom1 = new Error("cancel 1 failed");
    const boom2 = new Error("cancel 2 failed");
    (runs.cancel as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(boom1)
      .mockRejectedValueOnce(boom2);
    const store = makeStore();
    const onError = vi.fn();
    const adapter = new AgentServerQueueAdapter<State>(
      runs,
      "assistant-1",
      store,
      onError,
      getThread
    );
    await adapter.enqueue("thread-1", { count: 1 }, undefined);
    await adapter.enqueue("thread-1", { count: 2 }, undefined);

    await adapter.clear();

    expect(onError).toHaveBeenCalledTimes(1);
    const reportedError = onError.mock.calls[0][0] as AggregateError;
    expect(reportedError).toBeInstanceOf(AggregateError);
    expect(reportedError.errors).toEqual([boom1, boom2]);
  });

  it("enqueue() re-checks pending status after learning its runId if a 'running' event fired while create() was in flight", async () => {
    const { runs, getThread, emitStarted } = makeFakeBackend();
    const createDeferred = deferred<{ run_id: string }>();
    (runs.create as ReturnType<typeof vi.fn>).mockReturnValue(
      createDeferred.promise
    );
    (runs.list as ReturnType<typeof vi.fn>).mockResolvedValue([]); // no longer pending by the time we check
    const store = makeStore();
    const adapter = new AgentServerQueueAdapter<State>(
      runs,
      "assistant-1",
      store,
      vi.fn(),
      getThread
    );

    const enqueuePromise = adapter.enqueue("thread-1", { count: 1 }, undefined);
    expect(store.getSnapshot()).toHaveLength(1); // optimistic entry, no runId yet

    emitStarted(); // some run started while we were still waiting on create()
    await vi.waitFor(() => expect(store.getSnapshot()).toHaveLength(1)); // unaffected: no runId yet

    createDeferred.resolve({ run_id: "run-1" });
    await enqueuePromise;

    // The post-assignment re-check catches that it's already promoted.
    await vi.waitFor(() => expect(store.getSnapshot()).toHaveLength(0));
  });

  it("detach() does not drop a cancel marker for an entry whose create() is still in flight", async () => {
    const { runs, getThread } = makeFakeBackend();
    const createDeferred = deferred<{ run_id: string }>();
    (runs.create as ReturnType<typeof vi.fn>).mockReturnValue(
      createDeferred.promise
    );
    const store = makeStore();
    const adapter = new AgentServerQueueAdapter<State>(
      runs,
      "assistant-1",
      store,
      vi.fn(),
      getThread
    );

    const enqueuePromise = adapter.enqueue("thread-1", { count: 1 }, undefined);
    const id = store.getSnapshot()[0].id;
    await adapter.cancel(id); // marks pending-cancel; create() still in flight

    adapter.detach(); // must not drop the cancel marker

    createDeferred.resolve({ run_id: "run-1" });
    await enqueuePromise;

    expect(runs.cancel).toHaveBeenCalledWith("thread-1", "run-1");
  });

  // Exercises the #isStillQueued() helper shared with hydrate(), which
  // has the identical race and doesn't need its own copy of this test.
  it("a stale #refreshPending response does not evict an entry created after the list() request was sent, but still evicts one that legitimately started", async () => {
    const { runs, getThread, emitStarted } = makeFakeBackend();
    const listMock = runs.list as ReturnType<typeof vi.fn>;
    const listDeferred = deferred<Array<{ run_id: string; created_at: string }>>();
    listMock.mockReturnValueOnce(listDeferred.promise);
    const createMock = runs.create as ReturnType<typeof vi.fn>;
    createMock
      .mockResolvedValueOnce({ run_id: "run-old" })
      .mockResolvedValueOnce({ run_id: "run-new" });
    const store = makeStore();
    const adapter = new AgentServerQueueAdapter<State>(
      runs,
      "assistant-1",
      store,
      vi.fn(),
      getThread
    );

    await adapter.enqueue("thread-1", { count: 1 }, undefined); // run-old
    emitStarted(); // triggers #refreshPending; its list() call is now in flight

    await adapter.enqueue("thread-1", { count: 2 }, undefined); // run-new, created mid-flight

    listDeferred.resolve([]); // stale snapshot: taken before run-new existed; run-old genuinely started
    await vi.waitFor(() => {
      const snapshot = store.getSnapshot();
      expect(snapshot.find((e) => e.runId === "run-old")).toBeUndefined();
      expect(snapshot.find((e) => e.runId === "run-new")).toBeDefined();
    });
  });

  it("a late create() doesn't refresh a thread the adapter has since left, once detach()/hydrate() rebound it elsewhere", async () => {
    const { runs, getThread, emitStarted } = makeFakeBackend();
    const createDeferred = deferred<{ run_id: string }>();
    (runs.create as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      createDeferred.promise
    );
    const listMock = runs.list as ReturnType<typeof vi.fn>;
    // thread-a has nothing else pending; thread-b has run-b1.
    listMock.mockImplementation(async (threadId: string) =>
      threadId === "thread-b"
        ? [{ run_id: "run-b1", created_at: new Date().toISOString() }]
        : []
    );
    const store = makeStore();
    const adapter = new AgentServerQueueAdapter<State>(
      runs,
      "assistant-1",
      store,
      vi.fn(),
      getThread
    );

    const enqueuePromise = adapter.enqueue("thread-a", { count: 1 }, undefined); // create() deferred

    adapter.detach();
    await adapter.hydrate("thread-b");
    emitStarted(); // bumps the shared started-event counter; also re-checks thread-b
    await vi.waitFor(() =>
      expect(store.getSnapshot().find((e) => e.runId === "run-b1")).toBeDefined()
    );

    createDeferred.resolve({ run_id: "run-a1" }); // thread-a's create() finally lands
    await enqueuePromise;
    await vi.waitFor(() =>
      expect(store.getSnapshot().find((e) => e.runId === "run-a1")).toBeDefined()
    );

    // Must never have queried thread-a's (empty) pending list and used it
    // to wipe thread-b's queue.
    expect(listMock).not.toHaveBeenCalledWith(
      "thread-a",
      expect.anything()
    );
    expect(store.getSnapshot().find((e) => e.runId === "run-b1")).toBeDefined();
  });
});
