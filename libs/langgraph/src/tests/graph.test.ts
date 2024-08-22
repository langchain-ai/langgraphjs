/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, it, expect } from "@jest/globals";
import { StateGraph } from "../graph/state.js";
import { END, START } from "../web.js";
import { Annotation } from "../graph/annotation.js";

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
    const StateAnnotation = Annotation.Root({
      val: Annotation<number>,
      testval: Annotation<string[], string>({
        reducer: (left, right) =>
          right ? left.concat([right.toString()]) : left,
      }),
    });
    const stateGraph = new StateGraph(StateAnnotation);

    const graph = stateGraph
      .addNode("testnode", (state: typeof StateAnnotation.State) => {
        // Should properly be typed as string
        state.testval.concat(["stringval"]);
        // @ts-expect-error Should be typed as a number
        const valValue: string | undefined | null = state.val;
        return { testval: "hi!", val: 3 };
      })
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
