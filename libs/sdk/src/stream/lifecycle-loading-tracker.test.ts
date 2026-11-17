import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event, LifecycleEvent } from "@langchain/protocol";

import { LifecycleLoadingTracker } from "./lifecycle-loading-tracker.js";
import { StreamStore } from "../ui/store.js";

interface TestSnapshot {
  readonly isLoading: boolean;
  readonly other: number;
}

function makeStore(): StreamStore<TestSnapshot> {
  return new StreamStore<TestSnapshot>({ isLoading: false, other: 0 });
}

function lifecycleEvent(
  data: { event?: string; error?: string },
  overrides: { namespace?: string[]; seq?: number } = {}
): Event {
  return {
    type: "event",
    method: "lifecycle",
    seq: overrides.seq,
    params: {
      namespace: overrides.namespace ?? [],
      timestamp: Date.now(),
      data,
    },
  } as unknown as LifecycleEvent & Event;
}

function nonLifecycleEvent(): Event {
  return {
    type: "event",
    method: "values",
    params: {
      namespace: [],
      timestamp: Date.now(),
      data: { messages: [] },
    },
  } as unknown as Event;
}

describe("LifecycleLoadingTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flips isLoading to true on a root running event", () => {
    const store = makeStore();
    const tracker = new LifecycleLoadingTracker({
      store,
      isDisposed: () => false,
    });

    tracker.handle(lifecycleEvent({ event: "running" }, { seq: 1 }));

    expect(store.getSnapshot().isLoading).toBe(true);
    expect(store.getSnapshot().other).toBe(0);
  });

  it("flips isLoading to false after a terminal event on the next macrotask", () => {
    const store = makeStore();
    const tracker = new LifecycleLoadingTracker({
      store,
      isDisposed: () => false,
    });

    tracker.handle(lifecycleEvent({ event: "running" }, { seq: 1 }));
    tracker.handle(lifecycleEvent({ event: "completed" }, { seq: 2 }));

    // The terminal flip is deferred — synchronous read still loading.
    expect(store.getSnapshot().isLoading).toBe(true);

    vi.runAllTimers();
    expect(store.getSnapshot().isLoading).toBe(false);
  });

  it.each([["completed"], ["failed"], ["interrupted"]])(
    "treats %s as terminal",
    (terminal) => {
      const store = makeStore();
      const tracker = new LifecycleLoadingTracker({
        store,
        isDisposed: () => false,
      });

      tracker.handle(lifecycleEvent({ event: "running" }, { seq: 1 }));
      tracker.handle(lifecycleEvent({ event: terminal }, { seq: 2 }));
      vi.runAllTimers();

      expect(store.getSnapshot().isLoading).toBe(false);
    }
  );

  it("ignores non-root lifecycle events", () => {
    const store = makeStore();
    const tracker = new LifecycleLoadingTracker({
      store,
      isDisposed: () => false,
    });

    tracker.handle(
      lifecycleEvent({ event: "running" }, { namespace: ["task:1"], seq: 1 })
    );

    expect(store.getSnapshot().isLoading).toBe(false);
  });

  it("ignores non-lifecycle events", () => {
    const store = makeStore();
    const tracker = new LifecycleLoadingTracker({
      store,
      isDisposed: () => false,
    });

    tracker.handle(nonLifecycleEvent());

    expect(store.getSnapshot().isLoading).toBe(false);
  });

  it("ignores unknown lifecycle event names", () => {
    const store = makeStore();
    const tracker = new LifecycleLoadingTracker({
      store,
      isDisposed: () => false,
    });

    tracker.handle(lifecycleEvent({ event: "weird" }, { seq: 1 }));

    expect(store.getSnapshot().isLoading).toBe(false);
  });

  it("drops stale running events that arrive after a terminal", () => {
    const store = makeStore();
    const tracker = new LifecycleLoadingTracker({
      store,
      isDisposed: () => false,
    });

    tracker.handle(lifecycleEvent({ event: "running" }, { seq: 5 }));
    tracker.handle(lifecycleEvent({ event: "completed" }, { seq: 10 }));
    vi.runAllTimers();
    expect(store.getSnapshot().isLoading).toBe(false);

    // Replay an old `running` (e.g. SSE rotation re-streaming history).
    tracker.handle(lifecycleEvent({ event: "running" }, { seq: 7 }));
    expect(store.getSnapshot().isLoading).toBe(false);

    // A genuinely new `running` (higher seq) is honoured.
    tracker.handle(lifecycleEvent({ event: "running" }, { seq: 12 }));
    expect(store.getSnapshot().isLoading).toBe(true);
  });

  it("keeps isLoading true when a terminal's second copy arrives after the next run started", () => {
    const store = makeStore();
    const tracker = new LifecycleLoadingTracker({
      store,
      isDisposed: () => false,
    });

    tracker.handle(lifecycleEvent({ event: "running" }, { seq: 5 }));
    tracker.handle(lifecycleEvent({ event: "completed" }, { seq: 6 }));
    tracker.handle(lifecycleEvent({ event: "running" }, { seq: 7 }));
    tracker.handle(lifecycleEvent({ event: "completed" }, { seq: 6 }));
    vi.runAllTimers();

    expect(store.getSnapshot().isLoading).toBe(true);
  });

  it("keeps isLoading true when a newer running supersedes a deferred interrupt reset", () => {
    // Hydration / SSE replay of an answered HITL interrupt delivers
    // interrupted → running in the same turn. The interrupt's deferred
    // isLoading=false must not stomp the subsequent running.
    const store = makeStore();
    const tracker = new LifecycleLoadingTracker({
      store,
      isDisposed: () => false,
    });

    tracker.handle(lifecycleEvent({ event: "running" }, { seq: 1 }));
    tracker.handle(lifecycleEvent({ event: "interrupted" }, { seq: 34 }));
    tracker.handle(lifecycleEvent({ event: "running" }, { seq: 35 }));

    expect(store.getSnapshot().isLoading).toBe(true);

    vi.runAllTimers();
    expect(store.getSnapshot().isLoading).toBe(true);
  });

  it("still clears isLoading when a deferred terminal is not superseded", () => {
    const store = makeStore();
    const tracker = new LifecycleLoadingTracker({
      store,
      isDisposed: () => false,
    });

    tracker.handle(lifecycleEvent({ event: "running" }, { seq: 1 }));
    tracker.handle(lifecycleEvent({ event: "interrupted" }, { seq: 34 }));

    expect(store.getSnapshot().isLoading).toBe(true);
    vi.runAllTimers();
    expect(store.getSnapshot().isLoading).toBe(false);
  });

  it("running events without a seq always pass through", () => {
    const store = makeStore();
    const tracker = new LifecycleLoadingTracker({
      store,
      isDisposed: () => false,
    });

    tracker.handle(lifecycleEvent({ event: "completed" }, { seq: 5 }));
    vi.runAllTimers();

    // No seq → no stale check.
    tracker.handle(lifecycleEvent({ event: "running" }));
    expect(store.getSnapshot().isLoading).toBe(true);
  });

  it("does not write to the store after disposal", () => {
    const store = makeStore();
    let disposed = false;
    const tracker = new LifecycleLoadingTracker({
      store,
      isDisposed: () => disposed,
    });

    tracker.handle(lifecycleEvent({ event: "running" }, { seq: 1 }));
    tracker.handle(lifecycleEvent({ event: "completed" }, { seq: 2 }));

    disposed = true;
    vi.runAllTimers();

    // The store still reflects the synchronous `running=true`; the
    // deferred terminal flip was suppressed.
    expect(store.getSnapshot().isLoading).toBe(true);
  });

  it("reset() clears the terminal-seq guard so a new thread's running events apply", () => {
    const store = makeStore();
    const tracker = new LifecycleLoadingTracker({
      store,
      isDisposed: () => false,
    });

    tracker.handle(lifecycleEvent({ event: "running" }, { seq: 5 }));
    tracker.handle(lifecycleEvent({ event: "completed" }, { seq: 10 }));
    vi.runAllTimers();

    tracker.reset();
    // After reset, an old-seq running is no longer considered stale.
    tracker.handle(lifecycleEvent({ event: "running" }, { seq: 1 }));
    expect(store.getSnapshot().isLoading).toBe(true);
  });

  it("settles a new thread's terminal after reset()", () => {
    const store = makeStore();
    const tracker = new LifecycleLoadingTracker({
      store,
      isDisposed: () => false,
    });

    tracker.handle(lifecycleEvent({ event: "running" }, { seq: 1 }));
    tracker.handle(lifecycleEvent({ event: "interrupted" }, { seq: 34 }));
    tracker.handle(lifecycleEvent({ event: "running" }, { seq: 35 }));
    tracker.reset();
    tracker.handle(lifecycleEvent({ event: "running" }, { seq: 1 }));
    tracker.handle(lifecycleEvent({ event: "completed" }, { seq: 2 }));

    vi.runAllTimers();
    expect(store.getSnapshot().isLoading).toBe(false);
  });

  it("tracks runs by id across a new connection that numbers events from 1", () => {
    const store = makeStore();
    const tracker = new LifecycleLoadingTracker({
      store,
      isDisposed: () => false,
      runId: (event) => event.event_id,
    });
    const runEvent = (runId: string, event: string, seq: number) =>
      ({ ...lifecycleEvent({ event }, { seq }), event_id: runId }) as Event;

    tracker.handle(runEvent("run-1", "running", 300));
    tracker.handle(runEvent("run-1", "completed", 301));
    vi.runAllTimers();
    const updates = vi.fn();
    store.subscribe(updates);
    tracker.handle(runEvent("run-1", "running", 1));
    tracker.handle(runEvent("run-1", "completed", 2));
    vi.runAllTimers();
    expect(updates).not.toHaveBeenCalled();

    tracker.handle(runEvent("run-2", "running", 3));
    expect(store.getSnapshot().isLoading).toBe(true);
    tracker.handle(runEvent("run-2", "interrupted", 4));
    vi.runAllTimers();
    expect(store.getSnapshot().isLoading).toBe(false);
  });

  it("does not emit a redundant store update when isLoading is already true", () => {
    const store = makeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const tracker = new LifecycleLoadingTracker({
      store,
      isDisposed: () => false,
    });

    tracker.handle(lifecycleEvent({ event: "running" }, { seq: 1 }));
    expect(listener).toHaveBeenCalledTimes(1);

    tracker.handle(lifecycleEvent({ event: "running" }, { seq: 2 }));
    // Setting state to a new "isLoading: true" object is suppressed
    // because the tracker checks `s.isLoading` first.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not emit a redundant store update when isLoading is already false at terminal", () => {
    const store = makeStore();
    const tracker = new LifecycleLoadingTracker({
      store,
      isDisposed: () => false,
    });
    const listener = vi.fn();
    store.subscribe(listener);

    tracker.handle(lifecycleEvent({ event: "completed" }, { seq: 1 }));
    vi.runAllTimers();

    expect(listener).not.toHaveBeenCalled();
  });

  it("listener property is a stable bound reference", () => {
    const store = makeStore();
    const tracker = new LifecycleLoadingTracker({
      store,
      isDisposed: () => false,
    });

    expect(tracker.listener).toBe(tracker.listener);
    tracker.listener(lifecycleEvent({ event: "running" }, { seq: 1 }));
    expect(store.getSnapshot().isLoading).toBe(true);
  });
});
