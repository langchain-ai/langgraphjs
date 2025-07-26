import { describe, expect, it } from "vitest";
import { getBranchSequence } from "../react/stream.js";
import type { ThreadState, Checkpoint, Metadata } from "../schema.js";

function makeState(
  id: string,
  parentId?: string
): ThreadState<Record<string, unknown>> {
  const checkpoint: Checkpoint = {
    thread_id: "t",
    checkpoint_ns: "ns",
    checkpoint_id: id,
    checkpoint_map: null,
  };

  const parent_checkpoint = parentId
    ? { ...checkpoint, checkpoint_id: parentId }
    : null;

  const base: Partial<ThreadState> = {
    checkpoint,
    parent_checkpoint,
    values: {},
    next: [],
    metadata: {} as Metadata,
    created_at: undefined,
    tasks: [],
  };

  return base as ThreadState<Record<string, unknown>>;
}

describe("getBranchSequence", () => {
  it("handles truncated history missing root checkpoint", () => {
    const full = [
      makeState("c1"),
      makeState("c2", "c1"),
      makeState("c3", "c2"),
      makeState("c4", "c3"),
      makeState("c5", "c4"),
      makeState("c6", "c5"),
    ];

    const truncated = full.slice(1); // missing c1

    const { rootSequence } = getBranchSequence(truncated);
    expect(rootSequence.items.length).toBeGreaterThan(0);
  });
});
