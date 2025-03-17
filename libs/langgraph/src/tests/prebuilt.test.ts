/* eslint-disable no-process-env */
/* eslint-disable no-param-reassign */
/* eslint-disable no-return-assign */
import { beforeAll, describe, expect, it } from "vitest";
import { StructuredTool, tool } from "@langchain/core/tools";

import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { z } from "zod";
import { RunnableLambda } from "@langchain/core/runnables";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import {
  _AnyIdAIMessage,
  _AnyIdHumanMessage,
  _AnyIdToolMessage,
  FakeToolCallingChatModel,
  MemorySaverAssertImmutable,
} from "./utils.js";
import { ToolNode, createReactAgent } from "../prebuilt/index.js";
// Enable automatic config passing
import {
  Annotation,
  Command,
  messagesStateReducer,
  StateGraph,
} from "../index.js";
import { MessagesAnnotation } from "../graph/messages_annotation.js";

// Tracing slows down the tests
beforeAll(() => {
  if (typeof process !== "undefined") {
    process.env.LANGCHAIN_TRACING_V2 = "false";
    process.env.LANGCHAIN_ENDPOINT = "";
    process.env.LANGCHAIN_ENDPOINT = "";
    process.env.LANGCHAIN_API_KEY = "";
    process.env.LANGCHAIN_PROJECT = "";
  }
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

describe("createReactAgent with prompt/state modifier", () => {
  const tools = [new SearchAPI()];

  it("Can use string prompt", async () => {
    const llm = new FakeToolCallingChatModel({
      responses: [
        new AIMessage({
          content: "result1",
          tool_calls: [
            {
              name: "search_api",
              id: "tool_abcd123",
              args: { query: "foo" },
            },
          ],
        }),
        new AIMessage("result2"),
      ],
    });

    const agent1 = createReactAgent({
      llm,
      tools,
      prompt: "You are a helpful assistant",
    });

    const agent2 = createReactAgent({
      llm,
      tools,
      stateModifier: "You are a helpful assistant",
    });

    for (const agent of [agent1, agent2]) {
      const result = await agent.invoke({
        messages: [new HumanMessage("Hello Input!")],
      });

      const expected = [
        new _AnyIdHumanMessage("Hello Input!"),
        new _AnyIdAIMessage({
          content: "result1",
          tool_calls: [
            { name: "search_api", id: "tool_abcd123", args: { query: "foo" } },
          ],
        }),
        new _AnyIdToolMessage({
          name: "search_api",
          content: "result for foo",
          tool_call_id: "tool_abcd123",
          artifact: undefined,
        }),
        new _AnyIdAIMessage("result2"),
      ];
      expect(result.messages).toEqual(expected);
    }
  });

  it("Can use SystemMessage prompt", async () => {
    const llm = new FakeToolCallingChatModel({
      responses: [
        new AIMessage({
          content: "result1",
          tool_calls: [
            {
              name: "search_api",
              id: "tool_abcd123",
              args: { query: "foo" },
            },
          ],
        }),
        new AIMessage("result2"),
      ],
    });

    const agent1 = createReactAgent({
      llm,
      tools,
      prompt: new SystemMessage("You are a helpful assistant"),
    });

    const agent2 = createReactAgent({
      llm,
      tools,
      stateModifier: new SystemMessage("You are a helpful assistant"),
    });

    for (const agent of [agent1, agent2]) {
      const result = await agent.invoke({
        messages: [],
      });
      const expected = [
        new _AnyIdAIMessage({
          content: "result1",
          tool_calls: [
            { name: "search_api", id: "tool_abcd123", args: { query: "foo" } },
          ],
        }),
        new _AnyIdToolMessage({
          name: "search_api",
          content: "result for foo",
          tool_call_id: "tool_abcd123",
          artifact: undefined,
        }),
        new _AnyIdAIMessage("result2"),
      ];
      expect(result.messages).toEqual(expected);
    }
  });

  it("Can use a function as a prompt", async () => {
    const llm = new FakeToolCallingChatModel({});

    const agent1 = createReactAgent({
      llm,
      tools,
      prompt: (state) => {
        return [new AIMessage("foobar")].concat(state.messages);
      },
    });

    const agent2 = createReactAgent({
      llm,
      tools,
      stateModifier: (state) => {
        return [new AIMessage("foobar")].concat(state.messages);
      },
    });
    for (const agent of [agent1, agent2]) {
      const result = await agent.invoke({
        messages: [],
      });
      const expected = [new _AnyIdAIMessage("foobar")];
      expect(result.messages).toEqual(expected);
    }
  });

  it("Allows custom state schema that extends MessagesAnnotation", async () => {
    const llm = new FakeToolCallingChatModel({
      responses: [
        new AIMessage({
          content: "result1",
          tool_calls: [{ id: "test1234", args: {}, name: "test" }],
        }),
        new AIMessage("result2"),
      ],
    });

    const StateAnnotation = Annotation.Root({
      ...MessagesAnnotation.spec,
      foo: Annotation<string>,
    });

    const agent = createReactAgent({
      llm,
      tools: [
        tool(
          async () =>
            new Command({
              update: {
                foo: "baz",
              },
            }),
          {
            name: "test",
            schema: z.object({}),
          }
        ),
      ],
      stateSchema: StateAnnotation,
    });

    const result = await agent.invoke({
      messages: [],
      foo: "bar",
    });
    const expected = [
      new _AnyIdAIMessage({
        content: "result1",
        tool_calls: [{ id: "test1234", args: {}, name: "test" }],
      }),
      new _AnyIdAIMessage("result2"),
    ];
    expect(result.messages).toEqual(expected);
    expect(result.foo).toEqual("baz");
  });

  it("Should respect a passed signal", async () => {
    const llm = new FakeToolCallingChatModel({
      responses: [
        new AIMessage({
          content: "result1",
          tool_calls: [
            {
              name: "search_api",
              id: "tool_abcd123",
              args: { query: "foo" },
            },
          ],
        }),
        new AIMessage("result2"),
      ],
      sleep: 500,
    });

    const agent = createReactAgent({
      llm,
      tools: [new SearchAPIWithArtifact()],
      prompt: "You are a helpful assistant",
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
            {
              name: "search_api",
              id: "tool_abcd123",
              args: { query: "foo" },
            },
          ],
        }),
        new AIMessage("result2"),
      ],
    });

    const agent = createReactAgent({
      llm,
      tools: [new SearchAPIWithArtifact()],
      prompt: "You are a helpful assistant",
    });

    const result = await agent.invoke({
      messages: [new HumanMessage("Hello Input!")],
    });

    const expected = [
      new _AnyIdHumanMessage("Hello Input!"),
      new _AnyIdAIMessage({
        content: "result1",
        tool_calls: [
          { name: "search_api", id: "tool_abcd123", args: { query: "foo" } },
        ],
      }),
      new _AnyIdToolMessage({
        name: "search_api",
        content: "some response format",
        tool_call_id: "tool_abcd123",
        artifact: Buffer.from("123"),
      }),
      new _AnyIdAIMessage("result2"),
    ];
    expect(result.messages).toEqual(expected);
  });

  it("Can accept RunnableToolLike", async () => {
    const llm = new FakeToolCallingChatModel({
      responses: [
        new AIMessage({
          content: "result1",
          tool_calls: [
            {
              name: "search_api",
              id: "tool_abcd123",
              args: { query: "foo" },
            },
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
      prompt: "You are a helpful assistant",
    });

    const result = await agent.invoke({
      messages: [new HumanMessage("Hello Input!")],
    });

    const expected = [
      new _AnyIdHumanMessage("Hello Input!"),
      new _AnyIdAIMessage({
        content: "result1",
        tool_calls: [
          { name: "search_api", id: "tool_abcd123", args: { query: "foo" } },
        ],
      }),
      new _AnyIdToolMessage({
        name: "search_api",
        content: "result for foo",
        tool_call_id: "tool_abcd123",
      }),
      new _AnyIdAIMessage("result2"),
    ];
    expect(result.messages).toEqual(expected);
  });
});

describe("createReactAgent with bound tools", () => {
  it.each(["openai", "anthropic", "bedrock", "google"] as const)(
    "Can use bound tools and validate tool matching with %s style",
    async (toolStyle) => {
      const llm = new FakeToolCallingChatModel({
        responses: [new AIMessage("result")],
        toolStyle,
      });

      const tool1 = tool((input) => `Tool 1: ${input.someVal}`, {
        name: "tool1",
        description: "Tool 1 docstring.",
        schema: z.object({
          someVal: z.number().describe("Input value"),
        }),
      });

      const tool2 = tool((input) => `Tool 2: ${input.someVal}`, {
        name: "tool2",
        description: "Tool 2 docstring.",
        schema: z.object({
          someVal: z.number().describe("Input value"),
        }),
      });

      // Test valid agent constructor
      const agent = createReactAgent({
        llm: llm.bindTools([tool1, tool2]),
        tools: [tool1, tool2],
      });

      const result = await agent.nodes.tools.invoke({
        messages: [
          new AIMessage({
            content: "hi?",
            tool_calls: [
              {
                name: "tool1",
                args: { someVal: 2 },
                id: "some 1",
              },
              {
                name: "tool2",
                args: { someVal: 2 },
                id: "some 2",
              },
            ],
          }),
        ],
      });

      const toolMessages = ((result?.messages as BaseMessage[]) || []).slice(
        -2
      ) as ToolMessage[];
      for (const toolMessage of toolMessages) {
        expect(toolMessage._getType()).toBe("tool");
        expect(["Tool 1: 2", "Tool 2: 2"]).toContain(toolMessage.content);
        expect(["some 1", "some 2"]).toContain(toolMessage.tool_call_id);
      }

      // Test mismatching tool lengths
      expect(() => {
        createReactAgent({
          llm: llm.bindTools([tool1]),
          tools: [tool1, tool2],
        });
      }).toThrow();

      // Test missing bound tools
      expect(() => {
        createReactAgent({
          llm: llm.bindTools([tool1]),
          tools: [tool2],
        });
      }).toThrow();
    }
  );
});

describe("createReactAgent with legacy messageModifier", () => {
  const tools = [new SearchAPI()];

  it("Can use string message modifier", async () => {
    const llm = new FakeToolCallingChatModel({
      responses: [
        new AIMessage({
          content: "result1",
          tool_calls: [
            {
              name: "search_api",
              id: "tool_abcd123",
              args: { query: "foo" },
            },
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

    const expected = [
      new _AnyIdHumanMessage("Hello Input!"),
      new _AnyIdAIMessage({
        content: "result1",
        tool_calls: [
          { name: "search_api", id: "tool_abcd123", args: { query: "foo" } },
        ],
      }),
      new _AnyIdToolMessage({
        name: "search_api",
        content: "result for foo",
        tool_call_id: "tool_abcd123",
        artifact: undefined,
      }),
      new _AnyIdAIMessage("result2"),
    ];
    expect(result.messages).toEqual(expected);
  });

  it("Can use SystemMessage message modifier", async () => {
    const llm = new FakeToolCallingChatModel({
      responses: [
        new AIMessage({
          content: "result1",
          tool_calls: [
            {
              name: "search_api",
              id: "tool_abcd123",
              args: { query: "foo" },
            },
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
    const expected = [
      new _AnyIdAIMessage({
        content: "result1",
        tool_calls: [
          { name: "search_api", id: "tool_abcd123", args: { query: "foo" } },
        ],
      }),
      new _AnyIdToolMessage({
        name: "search_api",
        content: "result for foo",
        tool_call_id: "tool_abcd123",
        artifact: undefined,
      }),
      new _AnyIdAIMessage("result2"),
    ];
    expect(result.messages).toEqual(expected);
  });

  it("Can use a function as a message modifier", async () => {
    const llm = new FakeToolCallingChatModel({});

    const agent = createReactAgent({
      llm,
      tools,
      messageModifier: (messages) => {
        return [new AIMessage("foobar")].concat(messages);
      },
    });

    const result = await agent.invoke({
      messages: [],
    });
    const expected = [new _AnyIdAIMessage("foobar")];
    expect(result.messages).toEqual(expected);
  });

  it("Should respect a passed signal", async () => {
    const llm = new FakeToolCallingChatModel({
      responses: [
        new AIMessage({
          content: "result1",
          tool_calls: [
            {
              name: "search_api",
              id: "tool_abcd123",
              args: { query: "foo" },
            },
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
            {
              name: "search_api",
              id: "tool_abcd123",
              args: { query: "foo" },
            },
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

    const expected = [
      new _AnyIdHumanMessage("Hello Input!"),
      new _AnyIdAIMessage({
        content: "result1",
        tool_calls: [
          { name: "search_api", id: "tool_abcd123", args: { query: "foo" } },
        ],
      }),
      new _AnyIdToolMessage({
        name: "search_api",
        content: "some response format",
        tool_call_id: "tool_abcd123",
        artifact: Buffer.from("123"),
      }),
      new _AnyIdAIMessage("result2"),
    ];
    expect(result.messages).toEqual(expected);
  });

  it("Can accept RunnableToolLike", async () => {
    const llm = new FakeToolCallingChatModel({
      responses: [
        new AIMessage({
          content: "result1",
          tool_calls: [
            {
              name: "search_api",
              id: "tool_abcd123",
              args: { query: "foo" },
            },
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

    const expected = [
      new _AnyIdHumanMessage("Hello Input!"),
      new _AnyIdAIMessage({
        content: "result1",
        tool_calls: [
          { name: "search_api", id: "tool_abcd123", args: { query: "foo" } },
        ],
      }),
      new _AnyIdToolMessage({
        name: "search_api",
        content: "result for foo",
        tool_call_id: "tool_abcd123",
      }),
      new _AnyIdAIMessage("result2"),
    ];
    expect(result.messages).toEqual(expected);
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

  it("Should work when nested with a callback manager passed", async () => {
    const toolNode = new ToolNode([new SearchAPI()]);
    const wrapper = RunnableLambda.from(async (_) => {
      const res = await toolNode.invoke([
        new AIMessage({
          content: "",
          tool_calls: [
            { name: "search_api", args: { query: "foo" }, id: "testid" },
          ],
        }),
      ]);
      return res;
    });
    let runnableStartCount = 0;
    const callbackManager = new CallbackManager();
    callbackManager.addHandler(
      BaseCallbackHandler.fromMethods({
        handleChainStart: () => (runnableStartCount += 1),
        handleToolStart: () => (runnableStartCount += 1),
      })
    );
    await wrapper.invoke({}, { callbacks: callbackManager });
    expect(runnableStartCount).toEqual(2);
  });

  it("Should work in a state graph", async () => {
    const AgentAnnotation = Annotation.Root({
      messages: Annotation<BaseMessage[]>({
        reducer: messagesStateReducer,
        default: () => [],
      }),
      prop2: Annotation<string>,
    });

    const weatherTool = tool(
      async ({ query }) => {
        // This is a placeholder for the actual implementation
        if (
          query.toLowerCase().includes("sf") ||
          query.toLowerCase().includes("san francisco")
        ) {
          return "It's 60 degrees and foggy.";
        }
        return "It's 90 degrees and sunny.";
      },
      {
        name: "weather",
        description: "Call to get the current weather for a location.",
        schema: z.object({
          query: z.string().describe("The query to use in your search."),
        }),
      }
    );

    const aiMessage = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "call_1234",
          args: {
            query: "SF",
          },
          name: "weather",
          type: "tool_call",
        },
      ],
    });

    const aiMessage2 = new AIMessage({
      content: "FOO",
    });

    async function callModel(state: typeof AgentAnnotation.State) {
      // We return a list, because this will get added to the existing list
      if (state.messages.includes(aiMessage)) {
        return { messages: [aiMessage2] };
      }
      return { messages: [aiMessage] };
    }

    function shouldContinue({
      messages,
    }: typeof AgentAnnotation.State): "tools" | "__end__" {
      const lastMessage: AIMessage = messages[messages.length - 1];

      // If the LLM makes a tool call, then we route to the "tools" node
      if ((lastMessage.tool_calls?.length ?? 0) > 0) {
        return "tools";
      }
      // Otherwise, we stop (reply to the user)
      return "__end__";
    }

    const graph = new StateGraph(AgentAnnotation)
      .addNode("agent", callModel)
      .addNode("tools", new ToolNode([weatherTool]))
      .addEdge("__start__", "agent")
      .addConditionalEdges("agent", shouldContinue)
      .addEdge("tools", "agent")
      .compile();
    const res = await graph.invoke({
      messages: [],
    });
    const toolMessageId = res.messages[1].id;
    expect(res).toEqual({
      messages: [
        aiMessage,
        expect.objectContaining({
          id: toolMessageId,
          name: "weather",
          artifact: undefined,
          content: "It's 60 degrees and foggy.",
          tool_call_id: "call_1234",
        }),
        aiMessage2,
      ],
    });
  });
});

describe("MessagesAnnotation", () => {
  it("should assign ids properly and avoid duping added messages", async () => {
    const childGraph = new StateGraph(MessagesAnnotation)
      .addNode("duper", ({ messages }) => ({ messages }))
      .addNode("duper2", ({ messages }) => ({ messages }))
      .addEdge("__start__", "duper")
      .addEdge("duper", "duper2")
      .compile({ interruptBefore: ["duper2"] });
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("duper", childGraph)
      .addNode("duper2", ({ messages }) => ({ messages }))
      .addEdge("__start__", "duper")
      .addEdge("duper", "duper2")
      .compile({ checkpointer: new MemorySaverAssertImmutable() });
    const res = await graph.invoke(
      { messages: [new HumanMessage("should be only one")] },
      { configurable: { thread_id: "1" } }
    );
    const res2 = await graph.invoke(null, {
      configurable: { thread_id: "1" },
    });

    expect(res.messages.length).toEqual(1);
    expect(res2.messages.length).toEqual(1);
  });
});

describe("messagesStateReducer", () => {
  it("should dedupe messages", () => {
    const deduped = messagesStateReducer(
      [new HumanMessage({ id: "foo", content: "bar" })],
      [new HumanMessage({ id: "foo", content: "bar2" })]
    );
    expect(deduped.length).toEqual(1);
    expect(deduped[0].content).toEqual("bar2");
  });

  it("should dedupe messages if there are dupes on the right", () => {
    const messages = [
      new HumanMessage({ id: "foo", content: "bar" }),
      new HumanMessage({ id: "foo", content: "bar2" }),
    ];
    const deduped = messagesStateReducer([], messages);
    expect(deduped.length).toEqual(1);
    expect(deduped[0].content).toEqual("bar2");
  });

  it("should apply right-side messages in order", () => {
    const messages = [
      new RemoveMessage({ id: "foo" }),
      new HumanMessage({ id: "foo", content: "bar" }),
      new HumanMessage({ id: "foo", content: "bar2" }),
    ];
    const deduped = messagesStateReducer(
      [new HumanMessage({ id: "foo", content: "bar3" })],
      messages
    );
    expect(deduped.length).toEqual(1);
    expect(deduped[0].content).toEqual("bar2");
  });
});
