import { describe, it, expect } from "@jest/globals";
import { Annotation, StateGraph } from "../graph/state.js";
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
    const State = {
      val: Annotation<number>,
      testval: Annotation<string[], string>({
        reducer: (left, right) =>
          right ? left.concat([right.toString()]) : left,
      }),
    };
    const stateGraph = new StateGraph(State);

    const graph = stateGraph
      .addNode("testnode", (_) => ({ testval: "hi!", val: 3 }))
      .addEdge(START, "testnode")
      .addEdge("testnode", END)
      .compile();
    expect(await graph.invoke({ testval: ["hello"] })).toEqual({
      testval: ["hello", "hi!"],
      val: 3,
    });
  });

  it("should allow reducers with different argument types", async () => {
    const stateGraph = new StateGraph<
      unknown,
      { testval: string[] },
      { testval: string }
    >({
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
