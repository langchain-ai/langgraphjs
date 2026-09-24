import { describe, expect, it } from "vitest";
import { collectWaitingEdgesFromValues } from "./index.js";

/**
 * Unit-level, because the shapes come from what a barrier persists rather than
 * from anything a graph can be made to do: `NamedBarrierValue` checkpoints its
 * seen set, and the `defer` variant checkpoints `[seen, finished]`.
 */
describe("collectWaitingEdgesFromValues", () => {
  it("reads the plain barrier shape", () => {
    expect(
      collectWaitingEdgesFromValues({ "join:a+b:merge": ["a"] }, "sub:1")
    ).toEqual([
      {
        target: "merge",
        completed: ["a"],
        missing: ["b"],
        namespace: "sub:1",
        path: ["sub"],
      },
    ]);
  });

  it("omits missing when the name's parse contradicts what the barrier holds", () => {
    // `["a+b", "c"]` spells the same channel as `["a", "b+c"]`, so the split
    // cannot be trusted; `a+b` is not among its pieces, which is the tell.
    expect(
      collectWaitingEdgesFromValues({ "join:a+b+c:merge": ["a+b"] }, "sub:1")
    ).toEqual([
      {
        target: "merge",
        completed: ["a+b"],
        namespace: "sub:1",
        path: ["sub"],
      },
    ]);
  });

  it("handles a single-node waiting edge", () => {
    expect(
      collectWaitingEdgesFromValues({ "join:a:merge": ["a"] }, "sub:1")
    ).toEqual([]);
  });

  it("reads the defer barrier shape, ignoring the finished flag", () => {
    expect(
      collectWaitingEdgesFromValues(
        { "join:a+b:merge": [["a"], false] },
        "sub:1"
      )
    ).toEqual([
      {
        target: "merge",
        completed: ["a"],
        missing: ["b"],
        namespace: "sub:1",
        path: ["sub"],
      },
    ]);
  });

  it("treats a released edge as nothing to report", () => {
    expect(
      collectWaitingEdgesFromValues(
        { "join:a+b:merge": [], "join:c+d:other": [[], true] },
        "sub:1"
      )
    ).toEqual([]);
  });

  it("ignores channels that are not waiting edges", () => {
    expect(
      collectWaitingEdgesFromValues(
        { ran: ["a"], __pregel_tasks: [], "join:a+b:merge": ["a"] },
        ""
      )
    ).toHaveLength(1);
  });

  it("skips a value whose entries are not node names", () => {
    expect(
      collectWaitingEdgesFromValues({ "join:a+b:merge": [1, 2] }, "sub:1")
    ).toEqual([]);
  });

  it("builds the path from every namespace level, dropping task ids", () => {
    const [edge] = collectWaitingEdgesFromValues(
      { "join:a+b:merge": ["a"] },
      "outer:11111111-1111-5111-8111-111111111111|inner:22222222-2222-5222-8222-222222222222"
    );
    expect(edge.path).toEqual(["outer", "inner"]);
  });

  it("yields an empty path for this graph's own namespace", () => {
    const [edge] = collectWaitingEdgesFromValues(
      { "join:a+b:merge": ["a"] },
      ""
    );
    expect(edge.path).toEqual([]);
  });

  it("keeps a target name containing a plus, which node names allow", () => {
    const [edge] = collectWaitingEdgesFromValues(
      { "join:a+b:m+n": ["a"] },
      "sub:1"
    );
    expect(edge.target).toBe("m+n");
  });
});
