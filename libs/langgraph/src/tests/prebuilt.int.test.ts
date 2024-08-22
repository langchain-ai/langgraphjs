/* eslint-disable no-process-env */

import { it, beforeAll, describe, expect } from "@jest/globals";
import { Tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { z } from "zod";
import {
  createReactAgent,
  createFunctionCallingExecutor,
} from "../prebuilt/index.js";
import { initializeAsyncLocalStorageSingleton } from "../setup/async_local_storage.js";

// Tracing slows down the tests
beforeAll(() => {
  // process.env.LANGCHAIN_TRACING_V2 = "false";
  // process.env.LANGCHAIN_ENDPOINT = "";
  // process.env.LANGCHAIN_API_KEY = "";
  // process.env.LANGCHAIN_PROJECT = "";

  // Will occur naturally if user imports from main `@langchain/langgraph` endpoint.
  initializeAsyncLocalStorageSingleton();
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

    // It needs at least one human message, one AI and one function message.
    expect(response.messages.length > 3).toBe(true);
    const firstFunctionMessage = (response.messages as Array<BaseMessage>).find(
      (message) => message._getType() === "function"
    );
    expect(firstFunctionMessage).toBeDefined();
    expect(firstFunctionMessage?.content).toBe(weatherResponse);
  });

  it("can stream a function", async () => {
    const weatherResponse = `Not too cold, not too hot 😎`;
    const model = new ChatOpenAI({
      streaming: true,
    });
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

    const functionsAgentExecutor = createFunctionCallingExecutor({
      model,
      tools,
    });

    const stream = await functionsAgentExecutor.stream(
      {
        messages: [new HumanMessage("What's the weather like in SF?")],
      },
      { streamMode: "values" }
    );
    const fullResponse = [];
    for await (const item of stream) {
      fullResponse.push(item);
    }

    // human -> agent -> action -> agent
    expect(fullResponse.length).toEqual(4);

    const endState = fullResponse[fullResponse.length - 1];
    // 1 human, 2 llm calls, 1 function call.
    expect(endState.messages.length).toEqual(4);
    const functionCall = endState.messages.find(
      (message: BaseMessage) => message._getType() === "function"
    );
    expect(functionCall.content).toBe(weatherResponse);
  });

  it("can accept RunnableToolLike tools", async () => {
    const weatherResponse = `Not too cold, not too hot 😎`;
    const model = new ChatOpenAI();

    const sfWeatherTool = RunnableLambda.from(async (_) => weatherResponse);
    const tools = [
      sfWeatherTool.asTool({
        name: "current_weather",
        description: "Get the current weather report for San Francisco, CA",
        schema: z.object({
          location: z.string(),
        }),
      }),
    ];

    const functionsAgentExecutor = createFunctionCallingExecutor<ChatOpenAI>({
      model,
      tools,
    });

    const response = await functionsAgentExecutor.invoke({
      messages: [new HumanMessage("What's the weather like in SF?")],
    });

    // It needs at least one human message, one AI and one function message.
    expect(response.messages.length > 3).toBe(true);
    const firstFunctionMessage = (response.messages as Array<BaseMessage>).find(
      (message) => message._getType() === "function"
    );
    expect(firstFunctionMessage).toBeDefined();
    expect(firstFunctionMessage?.content).toBe(weatherResponse);
  });
});

describe("createReactAgent", () => {
  it("can call a tool", async () => {
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

    const reactAgent = createReactAgent({ llm: model, tools });

    const response = await reactAgent.invoke({
      messages: [new HumanMessage("What's the weather like in SF?")],
    });

    // It needs at least one human message and one AI message.
    expect(response.messages.length > 1).toBe(true);
    const lastMessage = response.messages[response.messages.length - 1];
    expect(lastMessage._getType()).toBe("ai");
    expect(lastMessage.content.toLowerCase()).toContain("not too cold");
  });

  it("can stream a tool call", async () => {
    const weatherResponse = `Not too cold, not too hot 😎`;
    const model = new ChatOpenAI({
      streaming: true,
    });
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

    const reactAgent = createReactAgent({ llm: model, tools });

    const stream = await reactAgent.stream(
      {
        messages: [new HumanMessage("What's the weather like in SF?")],
      },
      { streamMode: "values" }
    );
    const fullResponse = [];
    for await (const item of stream) {
      fullResponse.push(item);
    }

    // human -> agent -> action -> agent
    expect(fullResponse.length).toEqual(4);
    const endState = fullResponse[fullResponse.length - 1];
    // 1 human, 2 ai, 1 tool.
    expect(endState.messages.length).toEqual(4);

    const lastMessage = endState.messages[endState.messages.length - 1];
    expect(lastMessage._getType()).toBe("ai");
    expect(lastMessage.content.toLowerCase()).toContain("not too cold");
  });
});
