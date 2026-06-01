import { describe, expect, it, vi } from "vitest";

import { MessageMetadataTracker } from "./message-metadata-tracker.js";

describe("MessageMetadataTracker", () => {
  it("starts with an empty metadata map", () => {
    const tracker = new MessageMetadataTracker();
    expect(tracker.store.getSnapshot().size).toBe(0);
  });

  describe("bufferCheckpoint", () => {
    it("buffers an envelope keyed by namespace", () => {
      const tracker = new MessageMetadataTracker();
      tracker.bufferCheckpoint([], { id: "cp-1", parent_id: "cp-0" });

      const consumed = tracker.consumeCheckpoint([]);
      expect(consumed).toEqual({ id: "cp-1", parent_id: "cp-0" });
    });

    it("preserves namespaces with the same suffix as distinct keys", () => {
      const tracker = new MessageMetadataTracker();
      tracker.bufferCheckpoint(["a"], { id: "cp-a" });
      tracker.bufferCheckpoint(["b"], { id: "cp-b" });

      expect(tracker.consumeCheckpoint(["a"])).toMatchObject({ id: "cp-a" });
      expect(tracker.consumeCheckpoint(["b"])).toMatchObject({ id: "cp-b" });
    });

    it("ignores envelopes without a string id", () => {
      const tracker = new MessageMetadataTracker();
      tracker.bufferCheckpoint([], { id: undefined });
      tracker.bufferCheckpoint([], { parent_id: "cp-0" } as never);
      tracker.bufferCheckpoint([], null);

      expect(tracker.consumeCheckpoint([])).toBeUndefined();
    });

    it("omits parent_id when it is missing or non-string", () => {
      const tracker = new MessageMetadataTracker();
      tracker.bufferCheckpoint([], { id: "cp-1" });
      expect(tracker.consumeCheckpoint([])).toEqual({ id: "cp-1" });

      tracker.bufferCheckpoint([], {
        id: "cp-2",
        parent_id: 7 as unknown as string,
      });
      expect(tracker.consumeCheckpoint([])).toEqual({ id: "cp-2" });
    });

    it("overwrites a buffered envelope when a newer one arrives", () => {
      const tracker = new MessageMetadataTracker();
      tracker.bufferCheckpoint([], { id: "old" });
      tracker.bufferCheckpoint([], { id: "new", parent_id: "p" });

      expect(tracker.consumeCheckpoint([])).toEqual({
        id: "new",
        parent_id: "p",
      });
    });
  });

  describe("consumeCheckpoint", () => {
    it("returns undefined when no envelope is buffered", () => {
      const tracker = new MessageMetadataTracker();
      expect(tracker.consumeCheckpoint([])).toBeUndefined();
    });

    it("read-and-clears: a second consume returns undefined", () => {
      const tracker = new MessageMetadataTracker();
      tracker.bufferCheckpoint([], { id: "cp-1" });

      expect(tracker.consumeCheckpoint([])).toBeDefined();
      expect(tracker.consumeCheckpoint([])).toBeUndefined();
    });
  });

  describe("recordMessages", () => {
    it("writes a metadata entry for each message id", () => {
      const tracker = new MessageMetadataTracker();
      tracker.recordMessages(
        [{ id: "m1" }, { id: "m2" }],
        { parentCheckpointId: "cp-parent" }
      );

      const map = tracker.store.getSnapshot();
      expect(map.get("m1")).toEqual({ parentCheckpointId: "cp-parent" });
      expect(map.get("m2")).toEqual({ parentCheckpointId: "cp-parent" });
    });

    it("skips messages without a non-empty string id", () => {
      const tracker = new MessageMetadataTracker();
      tracker.recordMessages(
        [
          { id: "m1" },
          { id: "" },
          { id: undefined },
          {},
          { id: 3 as unknown as string },
        ],
        { parentCheckpointId: "cp-parent" }
      );

      const map = tracker.store.getSnapshot();
      expect(map.size).toBe(1);
      expect(map.has("m1")).toBe(true);
    });

    it("does not notify subscribers when nothing changed", () => {
      const tracker = new MessageMetadataTracker();
      tracker.recordMessages([{ id: "m1" }], {
        parentCheckpointId: "cp-1",
      });

      const listener = vi.fn();
      tracker.store.subscribe(listener);

      tracker.recordMessages([{ id: "m1" }], {
        parentCheckpointId: "cp-1",
      });

      expect(listener).not.toHaveBeenCalled();
    });

    it("notifies subscribers when a new id is added", () => {
      const tracker = new MessageMetadataTracker();
      tracker.recordMessages([{ id: "m1" }], {
        parentCheckpointId: "cp-1",
      });

      const listener = vi.fn();
      tracker.store.subscribe(listener);

      tracker.recordMessages([{ id: "m2" }], {
        parentCheckpointId: "cp-1",
      });

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("notifies when an existing id's parentCheckpointId changes", () => {
      const tracker = new MessageMetadataTracker();
      tracker.recordMessages([{ id: "m1" }], {
        parentCheckpointId: "cp-1",
      });

      const listener = vi.fn();
      tracker.store.subscribe(listener);

      tracker.recordMessages([{ id: "m1" }], {
        parentCheckpointId: "cp-2",
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(tracker.store.getSnapshot().get("m1")).toEqual({
        parentCheckpointId: "cp-2",
      });
    });

    it("preserves snapshot identity across no-op writes", () => {
      const tracker = new MessageMetadataTracker();
      tracker.recordMessages([{ id: "m1" }], {
        parentCheckpointId: "cp-1",
      });
      const before = tracker.store.getSnapshot();

      tracker.recordMessages([{ id: "m1" }], {
        parentCheckpointId: "cp-1",
      });

      expect(tracker.store.getSnapshot()).toBe(before);
    });
  });

  describe("reset", () => {
    it("clears buffered checkpoints and metadata", () => {
      const tracker = new MessageMetadataTracker();
      tracker.bufferCheckpoint([], { id: "cp-1" });
      tracker.recordMessages([{ id: "m1" }], {
        parentCheckpointId: "cp-1",
      });

      tracker.reset();

      expect(tracker.consumeCheckpoint([])).toBeUndefined();
      expect(tracker.store.getSnapshot().size).toBe(0);
    });

    it("notifies subscribers exactly once on a non-empty reset", () => {
      const tracker = new MessageMetadataTracker();
      tracker.recordMessages([{ id: "m1" }], {
        parentCheckpointId: "cp-1",
      });

      const listener = vi.fn();
      tracker.store.subscribe(listener);
      tracker.reset();

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  it("integrates with the buffer/consume/record flow used by the controller", () => {
    const tracker = new MessageMetadataTracker();

    // 1) Checkpoint event arrives first.
    tracker.bufferCheckpoint([], { id: "cp-1", parent_id: "cp-0" });

    // 2) Companion values event arrives — controller pulls the
    //    envelope and records metadata for each message id.
    const envelope = tracker.consumeCheckpoint([]);
    expect(envelope?.parent_id).toBe("cp-0");
    tracker.recordMessages([{ id: "m1" }, { id: "m2" }], {
      parentCheckpointId: envelope?.parent_id,
    });

    // 3) A subsequent values event without a fresh checkpoint must
    //    NOT reuse the previous parent_id.
    const stale = tracker.consumeCheckpoint([]);
    expect(stale).toBeUndefined();

    expect(tracker.store.getSnapshot().get("m1")).toEqual({
      parentCheckpointId: "cp-0",
    });
  });
});
