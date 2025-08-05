import { beforeAll, describe, it } from "vitest";
import { ChatOpenAI } from "@langchain/openai";
import {
  BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { Calculator } from "@langchain/community/tools/calculator";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { END, MessageGraph, START } from "../index.js";
import { initializeAsyncLocalStorageSingleton } from "../setup/async_local_storage.js";

describe("Chatbot", () => {
  beforeAll(() => {
    // Will occur naturally if user imports from main `@langchain/langgraph` endpoint.
    initializeAsyncLocalStorageSingleton();
  });

  it("Simple chat use-case", async () => {
    const model = new ChatOpenAI({ temperature: 0 });
    const graph = new MessageGraph()
      .addNode("oracle", async (state: BaseMessage[]) => model.invoke(state))
      .addEdge("oracle", END)
      .addEdge(START, "oracle")
      .compile();

    // @ts-expect-error Will be deprecated anyway
    const res = await graph.invoke(new HumanMessage("What is 1 + 1?"));

    console.log(res);
  });

  it("Chat use-case with tool calling", async () => {
    const model = new ChatOpenAI({
      temperature: 0,
    }).bind({
      tools: [convertToOpenAITool(new Calculator())],
      tool_choice: "auto",
    });

    const router = (state: BaseMessage[]) => {
      const toolCalls =
        state[state.length - 1].additional_kwargs.tool_calls ?? [];
      if (toolCalls.length) {
        return "calculator";
      } else {
        return "end";
      }
    };

    const graph = new MessageGraph()
      .addNode("oracle", async (state: BaseMessage[]) => model.invoke(state))
      .addNode("calculator", async (state: BaseMessage[]) => {
        const tool = new Calculator();
        const toolCalls =
          state[state.length - 1].additional_kwargs.tool_calls ?? [];
        const calculatorCall = toolCalls.find(
          (toolCall) => toolCall.function.name === "calculator"
        );
        if (calculatorCall === undefined) {
          throw new Error("No calculator input found.");
        }
        const result = await tool.invoke(
          JSON.parse(calculatorCall.function.arguments)
        );
        return new ToolMessage({
          tool_call_id: calculatorCall.id,
          content: result,
        });
      })
      .addEdge("calculator", END)
      .addEdge(START, "oracle")
      .addConditionalEdges("oracle", router, {
        calculator: "calculator",
        end: END,
      })
      .compile();

    // @ts-expect-error Will be deprecated anyway
    const res = await graph.invoke(new HumanMessage("What is 1 + 1?"));

    console.log(res);

    // @ts-expect-error Will be deprecated anyway
    const res2 = await graph.invoke(new HumanMessage("What is your name?"));

    console.log(res2);
  });
});
