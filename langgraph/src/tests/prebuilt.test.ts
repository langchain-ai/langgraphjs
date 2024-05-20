/* eslint-disable no-process-env */
import { beforeAll, describe, expect, it } from "@jest/globals";
import { PromptTemplate } from "@langchain/core/prompts";
import { StructuredTool, Tool } from "@langchain/core/tools";
import { FakeStreamingLLM } from "@langchain/core/utils/testing";

import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { BaseLLMParams } from "@langchain/core/language_models/llms";
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { ChatResult } from "@langchain/core/outputs";
import { RunnableLambda } from "@langchain/core/runnables";
import { z } from "zod";
import { createAgentExecutor, createReactAgent } from "../prebuilt/index.js";

// Tracing slows down the tests
beforeAll(() => {
  process.env.LANGCHAIN_TRACING_V2 = "false";
  process.env.LANGCHAIN_ENDPOINT = "";
  process.env.LANGCHAIN_ENDPOINT = "";
  process.env.LANGCHAIN_API_KEY = "";
  process.env.LANGCHAIN_PROJECT = "";
});

describe("PreBuilt", () => {
  class SearchAPI extends Tool {
    name = "search_api";

    description = "A simple API that returns the input string.";

    constructor() {
      super();
    }

    async _call(query: string): Promise<string> {
      return `result for ${query}`;
    }
  }
  const tools = [new SearchAPI()];

  it("Can invoke createAgentExecutor", async () => {
    const prompt = PromptTemplate.fromTemplate("Hello!");

    const llm = new FakeStreamingLLM({
      responses: [
        "tool:search_api:query",
        "tool:search_api:another",
        "finish:answer",
      ],
    });

    const agentParser = (input: string) => {
      if (input.startsWith("finish")) {
        const answer = input.split(":")[1];
        return {
          returnValues: { answer },
          log: input,
        };
      }
      const [, toolName, toolInput] = input.split(":");
      return {
        tool: toolName,
        toolInput,
        log: input,
      };
    };

    const agent = prompt.pipe(llm).pipe(agentParser);

    const agentExecutor = createAgentExecutor({
      agentRunnable: agent,
      tools,
    });

    const result = await agentExecutor.invoke({
      input: "what is the weather in sf?",
    });

    expect(result).toEqual({
      input: "what is the weather in sf?",
      agentOutcome: {
        returnValues: {
          answer: "answer",
        },
        log: "finish:answer",
      },
      steps: [
        {
          action: {
            tool: "search_api",
            toolInput: "query",
            log: "tool:search_api:query",
          },
          observation: "result for query",
        },
        {
          action: {
            tool: "search_api",
            toolInput: "another",
            log: "tool:search_api:another",
          },
          observation: "result for another",
        },
      ],
    });
  });

  it("Can stream createAgentExecutor", async () => {
    const prompt = PromptTemplate.fromTemplate("Hello!");

    const llm = new FakeStreamingLLM({
      responses: [
        "tool:search_api:query",
        "tool:search_api:another",
        "finish:answer",
      ],
    });

    const agentParser = (input: string) => {
      if (input.startsWith("finish")) {
        const answer = input.split(":")[1];
        return {
          returnValues: { answer },
          log: input,
        };
      }
      const [, toolName, toolInput] = input.split(":");
      return {
        tool: toolName,
        toolInput,
        log: input,
      };
    };

    const agent = prompt.pipe(llm).pipe(agentParser);

    const agentExecutor = createAgentExecutor({
      agentRunnable: agent,
      tools,
    });

    const stream = agentExecutor.stream({
      input: "what is the weather in sf?",
    });
    const fullResponse = [];
    for await (const item of await stream) {
      fullResponse.push(item);
    }

    expect(fullResponse.length > 3).toBe(true);

    const allAgentMessages = fullResponse.filter((res) => "agent" in res);
    expect(allAgentMessages.length >= 3).toBe(true);

    expect(fullResponse).toEqual([
      {
        agent: {
          agentOutcome: {
            log: "tool:search_api:query",
            tool: "search_api",
            toolInput: "query",
          },
        },
      },
      {
        action: {
          steps: [
            {
              action: {
                log: "tool:search_api:query",
                tool: "search_api",
                toolInput: "query",
              },
              observation: "result for query",
            },
          ],
        },
      },
      {
        agent: {
          agentOutcome: {
            log: "tool:search_api:another",
            tool: "search_api",
            toolInput: "another",
          },
        },
      },
      {
        action: {
          steps: [
            {
              action: {
                log: "tool:search_api:another",
                tool: "search_api",
                toolInput: "another",
              },
              observation: "result for another",
            },
          ],
        },
      },
      {
        agent: {
          agentOutcome: {
            log: "finish:answer",
            returnValues: {
              answer: "answer",
            },
          },
        },
      },
    ]);
  });
});

export class FakeToolCallingChatModel extends BaseChatModel {
  sleep?: number = 50;

  responses?: BaseMessage[];

  thrownErrorString?: string;

  idx: number;

  constructor(
    fields: {
      sleep?: number;
      responses?: BaseMessage[];
      thrownErrorString?: string;
    } & BaseLLMParams
  ) {
    super(fields);
    this.sleep = fields.sleep ?? this.sleep;
    this.responses = fields.responses;
    this.thrownErrorString = fields.thrownErrorString;
    this.idx = 0;
  }

  _llmType() {
    return "fake";
  }

  async _generate(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    if (this.thrownErrorString) {
      throw new Error(this.thrownErrorString);
    }
    const msg = this.responses?.[this.idx] ?? messages[this.idx];
    const generation: ChatResult = {
      generations: [
        {
          text: "",
          message: msg,
        },
      ],
    };
    this.idx += 1;

    return generation;
  }

  bindTools(_: Tool[]) {
    return new FakeToolCallingChatModel({
      sleep: this.sleep,
      responses: this.responses,
      thrownErrorString: this.thrownErrorString,
    });
  }
}

describe("createReactAgent", () => {
  const searchSchema = z.object({
    query: z.string().describe("The query to search for."),
  });

  class SearchAPI extends StructuredTool {
    name = "search_api";

    description = "A simple API that returns the input string.";

    schema = searchSchema;

    async _call(input: z.infer<typeof searchSchema>) {
      return `result for ${input?.query}`;
    }
  }

  const tools = [new SearchAPI()];

  it("Can use string message modifier", async () => {
    const llm = new FakeToolCallingChatModel({
      responses: [
        new AIMessage({
          content: "result1",
          tool_calls: [
            { name: "search_api", id: "tool_abcd123", args: { query: "foo" } },
          ],
        }),
        new AIMessage("result2"),
      ],
    });

    const agent = createReactAgent({
      llm,
      tools,
      messageModifier: "You are a helpful assistant",
    });

    const result = await agent.invoke({
      messages: [new HumanMessage("Hello Input!")],
    });

    expect(result.messages).toEqual([
      new HumanMessage("Hello Input!"),
      new AIMessage({
        content: "result1",
        tool_calls: [
          { name: "search_api", id: "tool_abcd123", args: { query: "foo" } },
        ],
      }),
      new ToolMessage({
        name: "search_api",
        content: "result for foo",
        tool_call_id: "tool_abcd123",
      }),
      new AIMessage("result2"),
    ]);
  });

  it("Can use SystemMessage message modifier", async () => {
    const llm = new FakeToolCallingChatModel({
      responses: [
        new AIMessage({
          content: "result1",
          tool_calls: [
            { name: "search_api", id: "tool_abcd123", args: { query: "foo" } },
          ],
        }),
        new AIMessage("result2"),
      ],
    });

    const agent = createReactAgent({
      llm,
      tools,
      messageModifier: new SystemMessage("You are a helpful assistant"),
    });

    const result = await agent.invoke({
      messages: [],
    });
    expect(result.messages).toEqual([
      new AIMessage({
        content: "result1",
        tool_calls: [
          { name: "search_api", id: "tool_abcd123", args: { query: "foo" } },
        ],
      }),
      new ToolMessage({
        name: "search_api",
        content: "result for foo",
        tool_call_id: "tool_abcd123",
      }),
      new AIMessage("result2"),
    ]);
  });

  it("Can use custom function message modifier", async () => {
    const aiM1 = new AIMessage({
      content: "result1",
      tool_calls: [
        { name: "search_api", id: "tool_abcd123", args: { query: "foo" } },
      ],
    });
    const aiM2 = new AIMessage("result2");
    const llm = new FakeToolCallingChatModel({
      responses: [aiM1, aiM2],
    });

    const messageModifier = (messages: BaseMessage[]) => [
      new SystemMessage("You are a helpful assistant"),
      ...messages,
    ];

    const agent = createReactAgent({ llm, tools, messageModifier });

    const result = await agent.invoke({
      messages: [new HumanMessage("Hello Input!")],
    });

    expect(result.messages).toEqual([
      new HumanMessage("Hello Input!"),
      aiM1,
      new ToolMessage({
        name: "search_api",
        content: "result for foo",
        tool_call_id: "tool_abcd123",
      }),
      aiM2,
    ]);
  });

  it("Can use async custom function message modifier", async () => {
    const aiM1 = new AIMessage({
      content: "result1",
      tool_calls: [
        { name: "search_api", id: "tool_abcd123", args: { query: "foo" } },
      ],
    });
    const aiM2 = new AIMessage("result2");
    const llm = new FakeToolCallingChatModel({
      responses: [aiM1, aiM2],
    });

    const messageModifier = async (messages: BaseMessage[]) => [
      new SystemMessage("You are a helpful assistant"),
      ...messages,
    ];

    const agent = createReactAgent({ llm, tools, messageModifier });

    const result = await agent.invoke({
      messages: [new HumanMessage("Hello Input!")],
    });

    expect(result.messages).toEqual([
      new HumanMessage("Hello Input!"),
      aiM1,
      new ToolMessage({
        name: "search_api",
        content: "result for foo",
        tool_call_id: "tool_abcd123",
      }),
      aiM2,
    ]);
  });

  it("Can use RunnableLambda message modifier", async () => {
    const aiM1 = new AIMessage({
      content: "result1",
      tool_calls: [
        { name: "search_api", id: "tool_abcd123", args: { query: "foo" } },
      ],
    });
    const aiM2 = new AIMessage("result2");
    const llm = new FakeToolCallingChatModel({
      responses: [aiM1, aiM2],
    });

    const messageModifier = new RunnableLambda({
      func: (messages: BaseMessage[]) => [
        new SystemMessage("You are a helpful assistant"),
        ...messages,
      ],
    });

    const agent = createReactAgent({ llm, tools, messageModifier });

    const result = await agent.invoke({
      messages: [
        new HumanMessage("Hello Input!"),
        new HumanMessage("Another Input!"),
      ],
    });

    expect(result.messages).toEqual([
      new HumanMessage("Hello Input!"),
      new HumanMessage("Another Input!"),
      aiM1,
      new ToolMessage({
        name: "search_api",
        content: "result for foo",
        tool_call_id: "tool_abcd123",
      }),
      aiM2,
    ]);
  });
});
