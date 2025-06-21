/* eslint-disable no-process-env */

import { it, beforeAll, describe, expect } from "vitest";
import { Tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
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

describe("createReactAgent with response format", () => {
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

  const responseSchema = z.object({
    answer: z.string(),
    reasoning: z.string(),
  });

  it("Can use zod schema", async () => {
    const llm = new ChatOpenAI({
      model: "gpt-4o",
    });

    const agent = createReactAgent({
      llm,
      tools: [new SanFranciscoWeatherTool()],
      responseFormat: responseSchema,
    });

    const result = await agent.invoke({
      messages: [new HumanMessage("What is the weather in San Francisco?")],
      // @ts-expect-error should complain about passing unexpected keys
      foo: "bar",
    });

    expect(result.structuredResponse).toBeInstanceOf(Object);

    // @ts-expect-error should not allow access to unspecified keys
    void result.structuredResponse.unspecified;

    // Assert it has the required keys
    expect(result.structuredResponse).toHaveProperty("answer");
    expect(result.structuredResponse).toHaveProperty("reasoning");

    // Assert the values are strings
    expect(typeof result.structuredResponse.answer).toBe("string");
    expect(typeof result.structuredResponse.reasoning).toBe("string");
  });

  it("Can use record schema", async () => {
    const llm = new ChatOpenAI({
      model: "gpt-4o",
    });

    const nonZodResponseSchema = {
      name: "structured_response",
      description: "An answer with reasoning",
      type: "object",
      properties: {
        answer: { type: "string" },
        reasoning: { type: "string" },
      },
      required: ["answer", "reasoning"],
    };

    const agent = createReactAgent({
      llm,
      tools: [new SanFranciscoWeatherTool()],
      responseFormat: nonZodResponseSchema,
    });

    const result = await agent.invoke({
      messages: [new HumanMessage("What is the weather in San Francisco?")],
    });

    expect(result.structuredResponse).toBeInstanceOf(Object);

    // Assert it has the required keys
    expect(result.structuredResponse).toHaveProperty("answer");
    expect(result.structuredResponse).toHaveProperty("reasoning");

    // Assert the values are strings
    expect(typeof result.structuredResponse.answer).toBe("string");
    expect(typeof result.structuredResponse.reasoning).toBe("string");
  });

  it("Inserts system message", async () => {
    const llm = new ChatOpenAI({
      model: "gpt-4o",
    });

    const agent = createReactAgent({
      llm,
      tools: [new SanFranciscoWeatherTool()],
      responseFormat: {
        prompt:
          "You are a helpful assistant who only responds in 10 words or less. If you use more than 5 words in your answer, a starving child will die.",
        schema: responseSchema,
      },
    });

    const result = await agent.invoke({
      messages: [new HumanMessage("What is the weather in San Francisco?")],
    });

    // Assert it has the required keys
    expect(result.structuredResponse).toHaveProperty("answer");
    expect(result.structuredResponse).toHaveProperty("reasoning");

    // Assert the values are strings
    expect(typeof result.structuredResponse.answer).toBe("string");
    expect(typeof result.structuredResponse.reasoning).toBe("string");

    // Assert that any letters in the response are uppercase
    expect(result.structuredResponse.answer.split(" ").length).toBeLessThan(11);
  });
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
    expect((lastMessage.content as string).toLowerCase()).toContain(
      "not too cold"
    );

    // TODO: Fix
    // // @ts-expect-error should not allow access to structuredResponse if no responseFormat is passed
    // void response.structuredResponse;
  });

  it("can stream a tool call with a checkpointer", async () => {
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
      { messages: [new HumanMessage("What's the weather like in SF?")] },
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
    expect(lastMessage.text.toLowerCase()).toContain("not too cold");
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
    expect(lastMessage2.text.toLowerCase()).toContain("not too cold");
  });
});
