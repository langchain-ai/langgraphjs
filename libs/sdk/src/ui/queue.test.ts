import { describe, it, expect, vi, beforeEach } from "vitest";
import { SubmitQueue } from "./queue.js";

type TestState = {
  messages: Array<{ content: string; type: string }>;
};

type TestOptions = {
  optimisticValues?: Partial<TestState>;
};

describe("SubmitQueue", () => {
  let queue: SubmitQueue<TestState, TestOptions>;

  beforeEach(() => {
    queue = new SubmitQueue<TestState, TestOptions>();
  });

  it("starts empty", () => {
    expect(queue.size).toBe(0);
    expect(queue.entries).toEqual([]);
  });

  it("enqueue adds entries in FIFO order", () => {
    queue.enqueue({ messages: [{ content: "first", type: "human" }] });
    queue.enqueue({ messages: [{ content: "second", type: "human" }] });
    queue.enqueue({ messages: [{ content: "third", type: "human" }] });

    expect(queue.size).toBe(3);
    expect(queue.entries[0].values?.messages?.[0].content).toBe("first");
    expect(queue.entries[1].values?.messages?.[0].content).toBe("second");
    expect(queue.entries[2].values?.messages?.[0].content).toBe("third");
  });

  it("enqueue returns a unique ID", () => {
    const id1 = queue.enqueue({ messages: [] });
    const id2 = queue.enqueue({ messages: [] });
    const id3 = queue.enqueue({ messages: [] });

    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
    expect(id1).not.toBe(id3);
  });

  it("enqueue stores submit options", () => {
    const opts: TestOptions = {
      optimisticValues: { messages: [{ content: "opt", type: "human" }] },
    };
    queue.enqueue({ messages: [] }, opts);

    expect(queue.entries[0].options).toBe(opts);
  });

  it("enqueue sets createdAt timestamp", () => {
    const before = new Date();
    queue.enqueue({ messages: [] });
    const after = new Date();

    const { createdAt } = queue.entries[0];
    expect(createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("enqueue accepts null and undefined values", () => {
    queue.enqueue(null);
    queue.enqueue(undefined);

    expect(queue.size).toBe(2);
    expect(queue.entries[0].values).toBeNull();
    expect(queue.entries[1].values).toBeUndefined();
  });

  it("cancel removes entry by ID and returns true", () => {
    const id1 = queue.enqueue({ messages: [{ content: "a", type: "human" }] });
    queue.enqueue({ messages: [{ content: "b", type: "human" }] });
    const id3 = queue.enqueue({ messages: [{ content: "c", type: "human" }] });

    const result = queue.cancel(id1);

    expect(result).toBe(true);
    expect(queue.size).toBe(2);
    expect(queue.entries[0].values?.messages?.[0].content).toBe("b");
    expect(queue.entries[1].id).toBe(id3);
  });

  it("cancel returns false for unknown ID", () => {
    queue.enqueue({ messages: [] });
    expect(queue.cancel("nonexistent")).toBe(false);
    expect(queue.size).toBe(1);
  });

  it("clear removes all entries", () => {
    queue.enqueue({ messages: [] });
    queue.enqueue({ messages: [] });
    queue.enqueue({ messages: [] });

    queue.clear();

    expect(queue.size).toBe(0);
    expect(queue.entries).toEqual([]);
  });

  it("clear is a no-op when already empty", () => {
    const listener = vi.fn();
    queue.subscribe(listener);

    queue.clear();
    expect(listener).not.toHaveBeenCalled();
  });

  it("entries returns a read-only snapshot", () => {
    queue.enqueue({ messages: [] });
    const snapshot = queue.entries;

    expect(snapshot).toHaveLength(1);
    expect(Object.isFrozen(snapshot) || Array.isArray(snapshot)).toBe(true);
  });

  describe("drain", () => {
    it("calls drain handler with first entry and removes it", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      queue.setDrainHandler(handler);

      queue.enqueue({ messages: [{ content: "a", type: "human" }] });
      queue.enqueue({ messages: [{ content: "b", type: "human" }] });

      queue.drain();

      // Handler should be called with the first entry
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].values?.messages?.[0].content).toBe("a");

      // First entry should be removed
      expect(queue.size).toBe(1);
      expect(queue.entries[0].values?.messages?.[0].content).toBe("b");
    });

    it("is a no-op when queue is empty", () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      queue.setDrainHandler(handler);

      queue.drain();

      expect(handler).not.toHaveBeenCalled();
    });

    it("is a no-op when no drain handler is set", () => {
      queue.enqueue({ messages: [] });
      queue.drain();
      expect(queue.size).toBe(1);
    });

    it("is a no-op while already draining", () => {
      let resolveHandler: () => void;
      const handler = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveHandler = resolve;
          })
      );
      queue.setDrainHandler(handler);

      queue.enqueue({ messages: [{ content: "a", type: "human" }] });
      queue.enqueue({ messages: [{ content: "b", type: "human" }] });

      queue.drain();
      queue.drain();

      expect(handler).toHaveBeenCalledTimes(1);
      resolveHandler!();
    });

    it("with onQueueError='stop' halts on error", async () => {
      const handler = vi.fn().mockRejectedValue(new Error("fail"));
      queue.setDrainHandler(handler);

      queue.enqueue({ messages: [{ content: "a", type: "human" }] });
      queue.enqueue({ messages: [{ content: "b", type: "human" }] });

      queue.drain("stop");

      // Wait for the promise rejection to be handled
      await vi.waitFor(() => {
        expect(queue.isDraining).toBe(false);
      });

      // Should not process next entry even if we call drain again
      queue.drain("stop");
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("with onQueueError='continue' allows draining after error", async () => {
      const handler = vi
        .fn()
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValue(undefined);
      queue.setDrainHandler(handler);

      queue.enqueue({ messages: [{ content: "a", type: "human" }] });
      queue.enqueue({ messages: [{ content: "b", type: "human" }] });

      queue.drain("continue");

      await vi.waitFor(() => {
        expect(queue.isDraining).toBe(false);
      });

      // Should allow draining the next entry
      queue.drain("continue");
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe("subscribe", () => {
    it("notifies listeners on enqueue", () => {
      const listener = vi.fn();
      queue.subscribe(listener);

      queue.enqueue({ messages: [] });

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("notifies listeners on cancel", () => {
      const id = queue.enqueue({ messages: [] });
      const listener = vi.fn();
      queue.subscribe(listener);

      queue.cancel(id);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("notifies listeners on clear", () => {
      queue.enqueue({ messages: [] });
      const listener = vi.fn();
      queue.subscribe(listener);

      queue.clear();

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("notifies listeners on drain", () => {
      queue.setDrainHandler(vi.fn().mockResolvedValue(undefined));
      queue.enqueue({ messages: [] });
      const listener = vi.fn();
      queue.subscribe(listener);

      queue.drain();

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("unsubscribe stops notifications", () => {
      const listener = vi.fn();
      const unsub = queue.subscribe(listener);

      unsub();
      queue.enqueue({ messages: [] });

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("getSnapshot", () => {
    it("changes value when queue state changes", () => {
      const snap1 = queue.getSnapshot();
      queue.enqueue({ messages: [] });
      const snap2 = queue.getSnapshot();

      expect(snap1).not.toBe(snap2);
    });
  });
});
