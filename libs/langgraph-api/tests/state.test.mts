import { describe, expect, test } from "vitest";
import type { StateSnapshot } from "@langchain/langgraph";

import { stateSnapshotToThreadState } from "../src/state.mjs";

const baseSnapshot = (
  overrides: Partial<StateSnapshot> = {}
): StateSnapshot => ({
  values: { ran: ["a"] },
  next: [],
  tasks: [],
  config: { configurable: { thread_id: "t", checkpoint_id: "c" } },
  ...overrides,
});

describe("stateSnapshotToThreadState", () => {
  test("carries waiting edges into the payload", () => {
    const payload = stateSnapshotToThreadState(
      baseSnapshot({
        waitingEdges: [
          { target: "merge", completed: ["a"], missing: ["b"] },
        ],
      })
    );

    expect(payload.waiting_edges).toEqual([
      { target: "merge", completed: ["a"], missing: ["b"] },
    ]);
  });

  test("carries a nested edge's path and namespace", () => {
    // A subgraph's edge can arrive without `missing`, when its channel name is
    // ambiguous. Declaring the field required here made `edge.missing.join()`
    // compile and throw at runtime.
    const payload = stateSnapshotToThreadState(
      baseSnapshot({
        waitingEdges: [
          {
            target: "imerge",
            completed: ["ia"],
            path: ["sub"],
            namespace: "sub:2095",
          },
        ],
      })
    );

    expect(payload.waiting_edges).toEqual([
      {
        target: "imerge",
        completed: ["ia"],
        path: ["sub"],
        namespace: "sub:2095",
      },
    ]);
    expect(payload.waiting_edges?.[0].missing).toBeUndefined();
  });

  test("omits the key when no edge is waiting", () => {
    const payload = stateSnapshotToThreadState(baseSnapshot());

    expect(payload.waiting_edges).toBeUndefined();
    expect("waiting_edges" in payload).toBe(false);
  });

  test("omits the key when the snapshot carries an empty array", () => {
    const payload = stateSnapshotToThreadState(
      baseSnapshot({ waitingEdges: [] })
    );

    expect("waiting_edges" in payload).toBe(false);
  });

  test("copies the entries rather than aliasing the snapshot's", () => {
    const snapshot = baseSnapshot({
      waitingEdges: [{ target: "merge", completed: ["a"], missing: ["b"] }],
    });
    const payload = stateSnapshotToThreadState(snapshot);

    expect(payload.waiting_edges?.[0]).not.toBe(snapshot.waitingEdges?.[0]);
    expect(payload.waiting_edges?.[0]).toEqual(snapshot.waitingEdges?.[0]);
  });
});
