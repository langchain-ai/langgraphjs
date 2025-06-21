/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, it, expect } from "vitest";
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
      testval: Annotation<string[], string | string[]>({
        reducer: (left, right) => {
          if (typeof right === "string") {
            return right ? left.concat([right.toString()]) : left;
          }
          return right.length ? left.concat(right) : left;
        },
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
      { testval: string | string[] }
    >({
      channels: {
        testval: {
          reducer: (left, right) => {
            if (typeof right === "string") {
              return right ? left.concat([right.toString()]) : left;
            }
            return right.length ? left.concat(right) : left;
          },
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

  it("should support addSequence", async () => {
    const stateGraph = new StateGraph(
      Annotation.Root({
        messages: Annotation<string[]>({
          default: () => [],
          reducer: (left, right) => [...left, ...right],
        }),
      })
    );

    const graph = stateGraph
      .addSequence({
        node1: () => ({ messages: ["from node1"] }),
        node2: () => ({ messages: ["from node2"] }),
        node3: () => ({ messages: ["from node3"] }),
      })
      .addEdge(START, "node1")
      .compile();

    const result = await graph.invoke({ messages: [] });
    expect(result.messages).toEqual(["from node1", "from node2", "from node3"]);
  });

  it("should add multiple nodes in parallel using array syntax", async () => {
    const stateGraph = new StateGraph(
      Annotation.Root({
        messages: Annotation<string[]>({
          default: () => [],
          reducer: (left, right) => [...left, ...right],
        }),
      })
    );

    const graph = stateGraph
      .addNode([
        ["node1", () => ({ messages: ["from node1"] })],
        ["node2", () => ({ messages: ["from node2"] })],
        ["node3", () => ({ messages: ["from node3"] })],
      ])
      .addEdge(START, "node1")
      .addEdge("node1", "node2")
      .addEdge("node2", "node3")
      .addEdge("node3", END)
      .compile();

    const result = await graph.invoke({ messages: [] });
    expect(result.messages).toEqual(["from node1", "from node2", "from node3"]);
  });

  it("should add multiple nodes in parallel using record syntax", async () => {
    const stateGraph = new StateGraph(
      Annotation.Root({
        messages: Annotation<string[]>({
          default: () => [],
          reducer: (left, right) => [...left, ...right],
        }),
      })
    );

    const graph = stateGraph
      .addNode({
        node1: () => ({ messages: ["from node1"] }),
        node2: () => ({ messages: ["from node2"] }),
        node3: () => ({ messages: ["from node3"] }),
      })
      .addEdge(START, "node1")
      .addEdge("node1", "node2")
      .addEdge("node2", "node3")
      .addEdge("node3", END)
      .compile();

    const result = await graph.invoke({ messages: [] });
    expect(result.messages).toEqual(["from node1", "from node2", "from node3"]);
  });

  it("should throw error when adding duplicate nodes in parallel", () => {
    const stateGraph = new StateGraph(
      Annotation.Root({
        messages: Annotation<string[]>({
          default: () => [],
          reducer: (left, right) => [...left, ...right],
        }),
      })
    );

    // Test duplicate nodes in array syntax
    expect(() => {
      stateGraph.addNode([
        ["duplicate", () => ({ messages: ["from node1"] })],
        ["duplicate", () => ({ messages: ["from node2"] })],
      ]);
    }).toThrow();
  });

  it("should throw error when adding empty node list", () => {
    const stateGraph = new StateGraph(
      Annotation.Root({
        messages: Annotation<string[]>({
          default: () => [],
          reducer: (left, right) => [...left, ...right],
        }),
      })
    );

    // Test empty array syntax
    expect(() => stateGraph.addNode([])).toThrow(
      "No nodes provided in `addNode`"
    );

    // Test empty object syntax
    expect(() => stateGraph.addNode({})).toThrow(
      "No nodes provided in `addNode`"
    );
  });

  it("should support metadata and subgraphs in parallel node addition", async () => {
    const stateGraph = new StateGraph(
      Annotation.Root({
        messages: Annotation<string[]>({
          default: () => [],
          reducer: (left, right) => [...left, ...right],
        }),
      })
    );

    const subgraph = new StateGraph<{ messages: string[] }>({
      channels: { messages: null },
    })
      .addNode("subnode", () => ({ messages: ["from subgraph"] }))
      .addEdge(START, "subnode")
      .addEdge("subnode", END)
      .compile();

    const graph = stateGraph
      .addNode([
        [
          "node1",
          () => ({ messages: ["from node1"] }),
          { metadata: { description: "node1" }, subgraphs: [subgraph] },
        ],
        [
          "node2",
          () => ({ messages: ["from node2"] }),
          { metadata: { description: "node2" } },
        ],
      ])
      .addEdge(START, "node1")
      .addEdge("node1", "node2")
      .addEdge("node2", END)
      .compile();

    const result = await graph.invoke({ messages: [] });
    expect(result.messages).toEqual(["from node1", "from node2"]);
  });
});
