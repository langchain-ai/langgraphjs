import { describe, it } from "@jest/globals";
import { ChatOpenAI } from "@langchain/openai";
import {
  BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { Calculator } from "langchain/tools/calculator";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { END, MessageGraph } from "../index.js";

describe("Chatbot", () => {
  it("Simple chat use-case", async () => {
    const model = new ChatOpenAI({ temperature: 0 });
    const graph = new MessageGraph();

    graph.addNode("oracle", async (state: BaseMessage[]) => {
      return model.invoke(state);
    });

    graph.addEdge("oracle", END);

    graph.setEntryPoint("oracle");

    const runnable = graph.compile();
    const res = await runnable.invoke(new HumanMessage("What is 1 + 1?"));

    console.log(res);
  });

  it("Chat use-case with tool calling", async () => {
    const model = new ChatOpenAI({
      temperature: 0,
    }).bind({
      tools: [convertToOpenAITool(new Calculator())],
      tool_choice: "auto",
    });

    const graph = new MessageGraph();

    graph.addNode("oracle", async (state: BaseMessage[]) => {
      return model.invoke(state);
    });

    graph.addNode("calculator", async (state: BaseMessage[]) => {
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
    });

    graph.addEdge("calculator", END);

    graph.setEntryPoint("oracle");

    const router = (state: BaseMessage[]) => {
      const toolCalls =
        state[state.length - 1].additional_kwargs.tool_calls ?? [];
      if (toolCalls.length) {
        return "calculator";
      } else {
        return "end";
      }
    };
    graph.addConditionalEdges("oracle", router, {
      calculator: "calculator",
      end: END,
    });

    const runnable = graph.compile();
    const res = await runnable.invoke(new HumanMessage("What is 1 + 1?"));

    console.log(res);

    const res2 = await runnable.invoke(new HumanMessage("What is your name?"));

    console.log(res2);
  });
});
