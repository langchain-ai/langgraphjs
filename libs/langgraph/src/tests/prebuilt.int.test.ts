/* eslint-disable no-process-env */

import { it, beforeAll, describe, expect } from "@jest/globals";
import { Tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import { createReactAgent } from "../prebuilt/index.js";
import { initializeAsyncLocalStorageSingleton } from "../setup/async_local_storage.js";
import { MemorySaverAssertImmutable } from "./utils.js";

// Tracing slows down the tests
beforeAll(() => {
  // process.env.LANGCHAIN_TRACING_V2 = "false";
  // process.env.LANGCHAIN_ENDPOINT = "";
  // process.env.LANGCHAIN_API_KEY = "";
  // process.env.LANGCHAIN_PROJECT = "";

  // Will occur naturally if user imports from main `@langchain/langgraph` endpoint.
  initializeAsyncLocalStorageSingleton();
});

describe("createReactAgent", () => {
  const weatherResponse = `Not too cold, not too hot 😎`;
  class SanFranciscoWeatherTool extends Tool {
    name = "current_weather_sf";

    description = "Get the current weather report for San Francisco, CA";

    constructor() {
      super();
    }

    async _call(_: string): Promise<string> {
      return weatherResponse;
    }
  }
  class NewYorkWeatherTool extends Tool {
    name = "current_weather_ny";

    description = "Get the current weather report for New York City, NY";

    constructor() {
      super();
    }

    async _call(_: string): Promise<string> {
      return weatherResponse;
    }
  }
  const tools = [new SanFranciscoWeatherTool(), new NewYorkWeatherTool()];

  it("can call a tool", async () => {
    const model = new ChatOpenAI({
      model: "gpt-4o",
    });
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

  it.only("can stream a tool call with a checkpointer", async () => {
    const model = new ChatOpenAI({
      model: "gpt-4o",
    });

    const checkpointer = new MemorySaverAssertImmutable();

    const reactAgent = createReactAgent({
      llm: model,
      tools,
      checkpointSaver: checkpointer,
    });

    const stream = await reactAgent.stream(
      {
        messages: [new HumanMessage("What's the weather like in SF?")],
      },
      { configurable: { thread_id: "foo" }, streamMode: "values" }
    );
    const fullResponse = [];
    for await (const item of stream) {
      fullResponse.push(item);
    }

    // human -> agent -> tool -> agent
    expect(fullResponse.length).toEqual(4);
    const endState = fullResponse[fullResponse.length - 1];
    // 1 human, 2 ai, 1 tool.
    expect(endState.messages.length).toEqual(4);

    const lastMessage = endState.messages[endState.messages.length - 1];
    expect(lastMessage._getType()).toBe("ai");
    expect(lastMessage.content.toLowerCase()).toContain("not too cold");
    const stream2 = await reactAgent.stream(
      {
        messages: [new HumanMessage("What about NYC?")],
      },
      { configurable: { thread_id: "foo" }, streamMode: "values" }
    );
    const fullResponse2 = [];
    for await (const item of stream2) {
      fullResponse2.push(item);
    }
    // human -> agent -> tool -> agent
    expect(fullResponse2.length).toEqual(4);
    const endState2 = fullResponse2[fullResponse2.length - 1];
    // 2 human, 4 ai, 2 tool.
    expect(endState2.messages.length).toEqual(8);

    const lastMessage2 = endState.messages[endState.messages.length - 1];
    expect(lastMessage2._getType()).toBe("ai");
    expect(lastMessage2.content.toLowerCase()).toContain("not too cold");
  });
});
