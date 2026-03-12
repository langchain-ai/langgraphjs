import { describe, expect, it } from "vitest";

import { createSubgraphValuesDeltaTracker } from "../src/stream.mjs";

describe("createSubgraphValuesDeltaTracker", () => {
  it("emits a full bootstrap snapshot first", () => {
    const tracker = createSubgraphValuesDeltaTracker();
    const values = {
      messages: [{ type: "human", content: "bootstrap" }],
      todos: [],
      files: {},
    };

    expect(tracker.next(["tools:call_1"], values)).toEqual(values);
  });

  it("emits only changed fields on subsequent updates", () => {
    const tracker = createSubgraphValuesDeltaTracker();

    tracker.next(["tools:call_1"], {
      messages: [{ type: "human", content: "bootstrap" }],
      todos: [],
      files: {},
      count: 1,
    });

    expect(
      tracker.next(["tools:call_1"], {
        messages: [{ type: "human", content: "bootstrap" }],
        todos: [{ id: "1", content: "x" }],
        files: {},
        count: 2,
      })
    ).toEqual({
      __langgraph_delta__: true,
      todos: [{ id: "1", content: "x" }],
      count: 2,
    });
  });

  it("includes deleted keys in delta payloads", () => {
    const tracker = createSubgraphValuesDeltaTracker();

    tracker.next(["tools:call_1"], {
      keep: true,
      remove: true,
    });

    expect(
      tracker.next(["tools:call_1"], {
        keep: true,
      })
    ).toEqual({
      __langgraph_delta__: true,
      __langgraph_deleted_keys__: ["remove"],
    });
  });

  it("returns null when nothing changed", () => {
    const tracker = createSubgraphValuesDeltaTracker();
    const values = {
      messages: [{ type: "human", content: "bootstrap" }],
      todos: [],
    };

    tracker.next(["tools:call_1"], values);
    expect(tracker.next(["tools:call_1"], values)).toBeNull();
  });
});
