import { describe, it, expect, vi, beforeEach } from "vitest";
import { PendingRunsTracker } from "./queue.js";

type TestState = {
  messages: Array<{ content: string; type: string }>;
};

type TestOptions = {
  optimisticValues?: Partial<TestState>;
};

describe("PendingRunsTracker", () => {
  let tracker: PendingRunsTracker<TestState, TestOptions>;

  beforeEach(() => {
    tracker = new PendingRunsTracker<TestState, TestOptions>();
  });

  it("starts empty", () => {
    expect(tracker.size).toBe(0);
    expect(tracker.entries).toEqual([]);
  });

  it("add appends entries in FIFO order", () => {
    tracker.add({
      id: "run-1",
      values: { messages: [{ content: "first", type: "human" }] },
      createdAt: new Date(),
    });
    tracker.add({
      id: "run-2",
      values: { messages: [{ content: "second", type: "human" }] },
      createdAt: new Date(),
    });
    tracker.add({
      id: "run-3",
      values: { messages: [{ content: "third", type: "human" }] },
      createdAt: new Date(),
    });

    expect(tracker.size).toBe(3);
    expect(tracker.entries[0].values?.messages?.[0].content).toBe("first");
    expect(tracker.entries[1].values?.messages?.[0].content).toBe("second");
    expect(tracker.entries[2].values?.messages?.[0].content).toBe("third");
  });

  it("add stores submit options", () => {
    const opts: TestOptions = {
      optimisticValues: { messages: [{ content: "opt", type: "human" }] },
    };
    tracker.add({
      id: "run-1",
      values: { messages: [] },
      options: opts,
      createdAt: new Date(),
    });

    expect(tracker.entries[0].options).toBe(opts);
  });

  it("shift removes and returns the first entry", () => {
    tracker.add({
      id: "run-1",
      values: { messages: [{ content: "a", type: "human" }] },
      createdAt: new Date(),
    });
    tracker.add({
      id: "run-2",
      values: { messages: [{ content: "b", type: "human" }] },
      createdAt: new Date(),
    });

    const entry = tracker.shift();

    expect(entry?.id).toBe("run-1");
    expect(entry?.values?.messages?.[0].content).toBe("a");
    expect(tracker.size).toBe(1);
    expect(tracker.entries[0].id).toBe("run-2");
  });

  it("shift returns undefined when empty", () => {
    expect(tracker.shift()).toBeUndefined();
  });

  it("remove removes entry by ID and returns true", () => {
    tracker.add({
      id: "run-1",
      values: { messages: [{ content: "a", type: "human" }] },
      createdAt: new Date(),
    });
    tracker.add({
      id: "run-2",
      values: { messages: [{ content: "b", type: "human" }] },
      createdAt: new Date(),
    });
    tracker.add({
      id: "run-3",
      values: { messages: [{ content: "c", type: "human" }] },
      createdAt: new Date(),
    });

    const result = tracker.remove("run-1");

    expect(result).toBe(true);
    expect(tracker.size).toBe(2);
    expect(tracker.entries[0].values?.messages?.[0].content).toBe("b");
    expect(tracker.entries[1].id).toBe("run-3");
  });

  it("remove returns false for unknown ID", () => {
    tracker.add({
      id: "run-1",
      values: { messages: [] },
      createdAt: new Date(),
    });
    expect(tracker.remove("nonexistent")).toBe(false);
    expect(tracker.size).toBe(1);
  });

  it("removeAll removes all entries and returns them", () => {
    tracker.add({
      id: "run-1",
      values: { messages: [] },
      createdAt: new Date(),
    });
    tracker.add({
      id: "run-2",
      values: { messages: [] },
      createdAt: new Date(),
    });
    tracker.add({
      id: "run-3",
      values: { messages: [] },
      createdAt: new Date(),
    });

    const removed = tracker.removeAll();

    expect(removed).toHaveLength(3);
    expect(removed[0].id).toBe("run-1");
    expect(tracker.size).toBe(0);
    expect(tracker.entries).toEqual([]);
  });

  it("removeAll returns empty array when already empty", () => {
    const removed = tracker.removeAll();
    expect(removed).toEqual([]);
  });

  it("removeAll is a no-op when already empty (no listener notification)", () => {
    const listener = vi.fn();
    tracker.subscribe(listener);

    tracker.removeAll();
    expect(listener).not.toHaveBeenCalled();
  });

  it("entries returns a read-only snapshot", () => {
    tracker.add({
      id: "run-1",
      values: { messages: [] },
      createdAt: new Date(),
    });
    const snapshot = tracker.entries;

    expect(snapshot).toHaveLength(1);
    expect(Array.isArray(snapshot)).toBe(true);
  });

  describe("subscribe", () => {
    it("notifies listeners on add", () => {
      const listener = vi.fn();
      tracker.subscribe(listener);

      tracker.add({
        id: "run-1",
        values: { messages: [] },
        createdAt: new Date(),
      });

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("notifies listeners on shift", () => {
      tracker.add({
        id: "run-1",
        values: { messages: [] },
        createdAt: new Date(),
      });
      const listener = vi.fn();
      tracker.subscribe(listener);

      tracker.shift();

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("notifies listeners on remove", () => {
      tracker.add({
        id: "run-1",
        values: { messages: [] },
        createdAt: new Date(),
      });
      const listener = vi.fn();
      tracker.subscribe(listener);

      tracker.remove("run-1");

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("notifies listeners on removeAll", () => {
      tracker.add({
        id: "run-1",
        values: { messages: [] },
        createdAt: new Date(),
      });
      const listener = vi.fn();
      tracker.subscribe(listener);

      tracker.removeAll();

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("unsubscribe stops notifications", () => {
      const listener = vi.fn();
      const unsub = tracker.subscribe(listener);

      unsub();
      tracker.add({
        id: "run-1",
        values: { messages: [] },
        createdAt: new Date(),
      });

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("getSnapshot", () => {
    it("changes value when tracker state changes", () => {
      const snap1 = tracker.getSnapshot();
      tracker.add({
        id: "run-1",
        values: { messages: [] },
        createdAt: new Date(),
      });
      const snap2 = tracker.getSnapshot();

      expect(snap1).not.toBe(snap2);
    });
  });
});
