/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, it, expect } from "@jest/globals";
import { AIMessage } from "@langchain/core/messages";
import { StateGraph } from "../graph/state.js";
import { END, MessagesAnnotation, START } from "../web.js";
import { Annotation } from "../graph/annotation.js";
import { exec } from "../pregel/exec.js";
import { FakeChatModel } from "./utils.js";

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
});

describe("Streaming", () => {
  it("should have strongly typed stream", async () => {
    const model = new FakeChatModel({
      responses: [new AIMessage("Cold, with a low of 3℃")],
    });

    const callModel = async (state: typeof MessagesAnnotation.State) => {
      // For versions of @langchain/core < 0.2.3, you must call `.stream()`
      // and aggregate the message from chunks instead of calling `.invoke()`.
      const { messages } = state;
      const responseMessage = await model.invoke(messages);
      return { messages: [responseMessage] };
    };

    const workflow = new StateGraph(MessagesAnnotation)
      .addNode("agent", callModel)
      .addEdge(START, "agent")
      .addEdge("agent", END);

    const graph = workflow.compile();

    const inputs = {
      messages: [{ role: "user", content: "what's the weather in sf" }],
    };

    const pv = exec(graph, { streamMode: "values" })(inputs);

    for await (const chunk of pv) {
      const [_mode, payload] = chunk;
      console.log(payload?.messages);
      console.log("\n====\n");
    }
  });
});
