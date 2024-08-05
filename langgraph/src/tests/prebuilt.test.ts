/* eslint-disable no-process-env */
/* esling-disable no-promise-executor-return */
import { beforeAll, describe, expect, it } from "@jest/globals";
import { PromptTemplate } from "@langchain/core/prompts";
import { StructuredTool, Tool } from "@langchain/core/tools";
import { FakeStreamingLLM } from "@langchain/core/utils/testing";

import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { z } from "zod";
import { RunnableLambda } from "@langchain/core/runnables";
import { FakeToolCallingChatModel } from "./utils.js";
import {
  ToolNode,
  createAgentExecutor,
  createReactAgent,
} from "../prebuilt/index.js";

// Tracing slows down the tests
beforeAll(() => {
  process.env.LANGCHAIN_TRACING_V2 = "false";
  process.env.LANGCHAIN_ENDPOINT = "";
  process.env.LANGCHAIN_ENDPOINT = "";
  process.env.LANGCHAIN_API_KEY = "";
  process.env.LANGCHAIN_PROJECT = "";
});

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

class SearchAPIWithArtifact extends StructuredTool {
  name = "search_api";

  description = "A simple API that returns the input string.";

  schema = searchSchema;

  responseFormat = "content_and_artifact";

  async _call(_: z.infer<typeof searchSchema>) {
    return ["some response format", Buffer.from("123")];
  }
}

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

describe("createReactAgent", () => {
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

  it("Should respect a passed signal", async () => {
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
      sleep: 500,
    });

    const agent = createReactAgent({
      llm,
      tools: [new SearchAPIWithArtifact()],
      messageModifier: "You are a helpful assistant",
    });

    const controller = new AbortController();

    setTimeout(() => controller.abort(), 100);

    await expect(async () => {
      await agent.invoke(
        {
          messages: [new HumanMessage("Hello Input!")],
        },
        {
          signal: controller.signal,
        }
      );
    }).rejects.toThrowError();
  });

  it("Works with tools that return content_and_artifact response format", async () => {
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
      tools: [new SearchAPIWithArtifact()],
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
        content: "some response format",
        tool_call_id: "tool_abcd123",
        artifact: Buffer.from("123"),
      }),
      new AIMessage("result2"),
    ]);
  });

  it("Can accept RunnableToolLike", async () => {
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

    // Instead of re-implementing the tool, wrap it in a RunnableLambda and
    // call `asTool` to create a RunnableToolLike.
    const searchApiTool = new SearchAPI();
    const runnableToolLikeTool = RunnableLambda.from<
      z.infer<typeof searchApiTool.schema>,
      ToolMessage
    >(async (input, config) => searchApiTool.invoke(input, config)).asTool({
      name: searchApiTool.name,
      description: searchApiTool.description,
      schema: searchApiTool.schema,
    });

    const agent = createReactAgent({
      llm,
      tools: [runnableToolLikeTool],
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
});

describe("ToolNode", () => {
  it("Should support graceful error handling", async () => {
    const toolNode = new ToolNode([new SearchAPI()]);
    const res = await toolNode.invoke([
      new AIMessage({
        content: "",
        tool_calls: [{ name: "badtool", args: {}, id: "testid" }],
      }),
    ]);
    expect(res[0].content).toEqual(
      `Error: Tool "badtool" not found.\n Please fix your mistakes.`
    );
  });
});
