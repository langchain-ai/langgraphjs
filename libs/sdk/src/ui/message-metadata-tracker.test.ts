import { describe, expect, it, vi } from "vitest";

import type { ThreadStateSelectField } from "../schema.js";
import {
  MessageMetadataTracker,
  findForkPoints,
  type HistoryEntry,
  type HistoryReader,
} from "./message-metadata-tracker.js";

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

    it("keeps the first parent recorded for a message", () => {
      const tracker = new MessageMetadataTracker();
      tracker.recordMessages([{ id: "m1" }], { parentCheckpointId: "cp-1" });
      tracker.recordMessages([{ id: "m1" }, { id: "m2" }], {
        parentCheckpointId: "cp-2",
      });

      expect(tracker.store.getSnapshot().get("m1")).toEqual({
        parentCheckpointId: "cp-1",
      });
      expect(tracker.store.getSnapshot().get("m2")).toEqual({
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

  it("records fork points in one update, keeping one already recorded", () => {
    const tracker = new MessageMetadataTracker();
    tracker.recordMessages([{ id: "a" }], { parentCheckpointId: "cp-a" });
    tracker.markPending(["b"]);
    const listener = vi.fn();
    tracker.store.subscribe(listener);

    tracker.recordForkPoints(
      new Map([
        ["a", "cp-new"],
        ["b", "cp-b"],
        ["c", "cp-c"],
      ])
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(tracker.store.getSnapshot()).toEqual(
      new Map([
        ["a", { parentCheckpointId: "cp-a" }],
        ["b", { parentCheckpointId: "cp-b", optimisticStatus: "pending" }],
        ["c", { parentCheckpointId: "cp-c" }],
      ])
    );
  });

  describe("optimistic status", () => {
    it("marks ids pending", () => {
      const tracker = new MessageMetadataTracker();
      tracker.markPending(["a", "b"]);
      expect(tracker.store.getSnapshot().get("a")?.optimisticStatus).toBe(
        "pending"
      );
      expect(tracker.unpersistedOptimisticIds()).toEqual(new Set(["a", "b"]));
    });

    it("resolvePending only affects ids currently pending", () => {
      const tracker = new MessageMetadataTracker();
      tracker.markPending(["a"]);
      // "server" message id "b" was never optimistic — must stay clean.
      tracker.resolvePending(["a", "b"], "sent");
      expect(tracker.store.getSnapshot().get("a")?.optimisticStatus).toBe(
        "sent"
      );
      expect(tracker.store.getSnapshot().has("b")).toBe(false);
      expect(tracker.unpersistedOptimisticIds().size).toBe(0);
    });

    it("treats failed ids as unpersisted", () => {
      const tracker = new MessageMetadataTracker();
      tracker.markPending(["a"]);
      tracker.resolvePending(["a"], "failed");
      expect(tracker.unpersistedOptimisticIds()).toEqual(new Set(["a"]));
    });

    it("forget removes status and metadata for ids", () => {
      const tracker = new MessageMetadataTracker();
      tracker.markPending(["a"]);
      tracker.forget(["a"]);
      expect(tracker.store.getSnapshot().has("a")).toBe(false);
      expect(tracker.unpersistedOptimisticIds().size).toBe(0);
    });

    it("preserves parentCheckpointId when marking pending", () => {
      const tracker = new MessageMetadataTracker();
      tracker.recordMessages([{ id: "a" }], { parentCheckpointId: "cp-1" });
      tracker.markPending(["a"]);
      expect(tracker.store.getSnapshot().get("a")).toEqual({
        parentCheckpointId: "cp-1",
        optimisticStatus: "pending",
      });
    });

    it("fills the parent of a pending message from its first snapshot", () => {
      const tracker = new MessageMetadataTracker();
      tracker.markPending(["a"]);
      tracker.recordMessages([{ id: "a" }], { parentCheckpointId: "cp-1" });
      expect(tracker.store.getSnapshot().get("a")).toEqual({
        parentCheckpointId: "cp-1",
        optimisticStatus: "pending",
      });
    });

    it("clears all optimistic state on reset", () => {
      const tracker = new MessageMetadataTracker();
      tracker.markPending(["a"]);
      tracker.reset();
      expect(tracker.unpersistedOptimisticIds().size).toBe(0);
      expect(tracker.store.getSnapshot().size).toBe(0);
    });
  });
});

type FakeCheckpoint = {
  id: string;
  parent?: string;
  wrote?: string[];
  holds?: string[];
};

function history(
  checkpoints: FakeCheckpoint[],
  { ignoresSelect = false } = {}
) {
  const byId = new Map(checkpoints.map((c) => [c.id, c]));
  const held = (checkpoint: FakeCheckpoint): string[] => {
    if (checkpoint.holds != null) return checkpoint.holds;
    const parent = byId.get(checkpoint.parent ?? "");
    return parent == null
      ? []
      : [...new Set([...held(parent), ...(parent.wrote ?? [])])];
  };
  const messages = (ids: string[]) =>
    ids.map((id) => ({ id, type: "ai", content: id }));
  const config = (id: string) => ({
    thread_id: "t1",
    checkpoint_ns: "",
    checkpoint_id: id,
    checkpoint_map: null,
  });
  const entry = (checkpoint: FakeCheckpoint): HistoryEntry => ({
    checkpoint: config(checkpoint.id),
    parent_checkpoint:
      checkpoint.parent == null ? null : config(checkpoint.parent),
    tasks: [
      {
        id: `task-${checkpoint.id}`,
        name: "node",
        error: null,
        interrupts: [],
        checkpoint: null,
        state: null,
        result: { messages: messages(checkpoint.wrote ?? []) },
      },
    ],
    values: { messages: messages(held(checkpoint)) },
  });
  const project = (full: HistoryEntry, select: ThreadStateSelectField[]) =>
    Object.fromEntries(
      Object.entries(full).filter(
        ([key]) =>
          select.includes(key as ThreadStateSelectField) ||
          (key === "values" && select.includes("values.messages"))
      )
    ) as HistoryEntry;

  return vi.fn<HistoryReader>(async ({ limit, before, checkpoint, select }) => {
    const at = (id: string) => checkpoints.findIndex((c) => c.id === id);
    const from =
      checkpoint != null ? at(checkpoint) : before != null ? at(before) + 1 : 0;
    return checkpoints
      .slice(from, from + limit)
      .map((c) => (ignoresSelect ? entry(c) : project(entry(c), select)));
  });
}

function chain(length: number, wrote: Record<number, string[]>) {
  return Array.from({ length }, (_, index) => {
    const step = length - 1 - index;
    return {
      id: `c${step}`,
      parent: step === 0 ? undefined : `c${step - 1}`,
      wrote: wrote[step],
    };
  });
}

describe("findForkPoints", () => {
  const find = (read: HistoryReader, ids: string[], seen?: Set<string>) =>
    findForkPoints(read, "messages", new Set(ids), seen);

  it("follows parent links past another branch that wrote the same message", async () => {
    const read = history([
      { id: "c4", parent: "c3" },
      { id: "c3", parent: "c1", wrote: ["h2"] },
      { id: "c2", parent: "c1", wrote: ["h2"] },
      { id: "c1", parent: "c0", wrote: ["a1"] },
      { id: "c0", wrote: ["h1"] },
    ]);

    const { forkPoints } = await find(read, ["h1", "a1", "h2"]);

    expect(forkPoints).toEqual(
      new Map([
        ["h1", "c0"],
        ["a1", "c1"],
        ["h2", "c3"],
      ])
    );
  });

  it("takes a message's earliest write when a graph writes old messages again", async () => {
    const read = history([
      { id: "c4", parent: "c3" },
      { id: "c3", parent: "c2", wrote: ["h1", "a1", "h2", "a2"] },
      { id: "c2", parent: "c1", wrote: ["h2"] },
      { id: "c1", parent: "c0", wrote: ["h1", "a1"] },
      { id: "c0", wrote: ["h1"] },
    ]);

    const { forkPoints } = await find(read, ["h1", "a1", "h2", "a2"]);

    expect(forkPoints).toEqual(
      new Map([
        ["h1", "c0"],
        ["a1", "c1"],
        ["h2", "c2"],
        ["a2", "c3"],
      ])
    );
  });

  it("stopped by the page limit, places none of the messages its oldest checkpoint holds", async () => {
    const read = history(
      chain(520, { 0: ["ancient"], 5: ["old"], 515: ["old", "new"] })
    );

    const { forkPoints } = await find(read, ["ancient", "old", "new"]);

    expect(forkPoints).toEqual(new Map([["new", "c515"]]));
    expect(read).toHaveBeenCalledTimes(7);
    expect(read).toHaveBeenLastCalledWith({
      limit: 1,
      checkpoint: "c10",
      select: ["checkpoint", "values.messages"],
    });
  });

  it("places a message no step wrote, as one added with updateState, from the messages, and an unsaved one nowhere", async () => {
    const read = history([
      { id: "c3", parent: "c2", holds: ["h1", "a1", "u1"] },
      { id: "c2", parent: "c1" },
      { id: "c1", parent: "c0", wrote: ["a1"] },
      { id: "c0", wrote: ["h1"] },
    ]);

    const { forkPoints } = await find(read, ["h1", "a1", "u1", "unsaved"]);

    expect(forkPoints).toEqual(
      new Map([
        ["h1", "c0"],
        ["a1", "c1"],
        ["u1", "c2"],
      ])
    );
  });

  it("places an exit-durability run's messages from the messages, and none in the first checkpoint", async () => {
    const read = history([
      { id: "c1", parent: "c0", holds: ["h1", "a1", "h2", "a2"] },
      { id: "c0", holds: ["h1", "a1"] },
    ]);

    const { forkPoints } = await find(read, ["h1", "a1", "h2", "a2"]);

    expect(forkPoints).toEqual(
      new Map([
        ["h2", "c0"],
        ["a2", "c0"],
      ])
    );
  });

  it("stops after a checkpoint an earlier read read, taking that checkpoint's writes", async () => {
    const read = history([
      { id: "c3", parent: "c2" },
      { id: "c2", parent: "c1", wrote: ["a2"] },
      { id: "c1", parent: "c0", wrote: ["h2"] },
      { id: "c0", wrote: ["a2"] },
    ]);

    const { forkPoints, visited } = await find(
      read,
      ["h2", "a2"],
      new Set(["c1"])
    );

    expect(forkPoints).toEqual(
      new Map([
        ["h2", "c1"],
        ["a2", "c2"],
      ])
    );
    expect(visited).toEqual(["c3", "c2", "c1"]);
  });

  it("reads one page of steps from a server that ignores select", async () => {
    const read = history(chain(30, { 5: ["old"], 25: ["new"] }), {
      ignoresSelect: true,
    });

    const { forkPoints } = await find(read, ["old", "new"]);

    expect(forkPoints).toEqual(new Map([["new", "c25"]]));
    expect(read).toHaveBeenCalledTimes(2);
  });
});
