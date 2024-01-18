/* eslint-disable no-process-env */

import { it, beforeAll, describe, expect } from "@jest/globals";
import { Tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import { createFunctionCallingExecutor } from "../prebuilt/index.js";

// If you have LangSmith set then it slows down the tests
// immensely, and will most likely rate limit your account.
beforeAll(() => {
  process.env.LANGCHAIN_TRACING_V2 = "false";
  process.env.LANGCHAIN_ENDPOINT = "";
  process.env.LANGCHAIN_ENDPOINT = "";
  process.env.LANGCHAIN_API_KEY = "";
  process.env.LANGCHAIN_PROJECT = "";
});

describe("createFunctionCallingExecutor", () => {
  it("can call a function", async () => {
    const weatherResponse = `Not too cold, not too hot 😎`;
    const model = new ChatOpenAI();
    class SanFranciscoWeatherTool extends Tool {
      name = "current_weather";

      description = "Get the current weather report for San Francisco, CA";

      constructor() {
        super();
      }

      async _call(_: string): Promise<string> {
        return weatherResponse;
      }
    }
    const tools = [new SanFranciscoWeatherTool()];

    const functionsAgentExecutor = createFunctionCallingExecutor<ChatOpenAI>({
      model,
      tools,
    });

    const response = await functionsAgentExecutor.invoke({
      messages: [new HumanMessage("What's the weather like in SF?")],
    });

    console.log(response);
    // It needs at least one human message, one AI and one function message.
    expect(response.messages.length > 3).toBe(true);
    const firstFunctionMessage = (response.messages as Array<BaseMessage>).find(
      (message) => message._getType() === "function"
    );
    expect(firstFunctionMessage).toBeDefined();
    expect(firstFunctionMessage?.content).toBe(weatherResponse);
  });
});
