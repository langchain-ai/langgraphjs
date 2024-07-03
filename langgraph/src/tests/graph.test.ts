import { describe, it, expect } from "@jest/globals";
import { StateGraph } from "../graph/state.js";
import { END, START } from "../web.js";

describe("State", () => {
  it("should validate a new node key correctly ", () => {
    const stateGraph = new StateGraph<{
      existingStateAttributeKey: string;
    }>({
      channels: { existingStateAttributeKey: null },
    });
    expect(() => {
      stateGraph.addNode("existingStateAttributeKey", (_) => ({}));
    }).toThrow("existingStateAttributeKey");

    expect(() => {
      stateGraph.addNode("newNodeKey", (_) => ({}));
    }).not.toThrow();
  });

  it("should allow reducers with different argument types", async () => {
    const stateGraph = new StateGraph<{
      testval: string[];
    }>({
      channels: {
        testval: {
          reducer: (left: string[], right?: string) =>
            right ? left.concat([right.toString()]) : left,
        },
      },
    });

    const graph = stateGraph
      .addNode("testnode", (_) => ({ testval: "hi!" }))
      .addEdge(START, "testnode")
      .addEdge("testnode", END)
      .compile();
    expect(await graph.invoke({ testval: ["hello"] })).toEqual({
      testval: ["hello", "hi!"],
    });
  });
});
