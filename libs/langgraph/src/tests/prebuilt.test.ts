/* eslint-disable no-process-env */
/* eslint-disable no-param-reassign */
/* eslint-disable no-return-assign */
import { beforeAll, describe, expect, it } from "@jest/globals";
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
import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables";
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
import {
  _shouldBindTools,
  _getModel,
} from "../prebuilt/react_agent_executor.js";
// Enable automatic config passing
import {
  Annotation,
  Command,
  GraphInterrupt,
  interrupt,
  MemorySaver,
  messagesStateReducer,
  Send,
  StateGraph,
} from "../index.js";
import { MessagesAnnotation } from "../graph/messages_annotation.js";

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
    if (input?.query === "error") {
      throw new Error("Error");
    }
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

describe("createReactAgent with ToolNode", () => {
  it("Should work with ToolNode", async () => {
    const llm = new FakeToolCallingChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              name: "search_api",
              id: "tool_abcd123",
              args: { query: "foo" },
            },
          ],
        }),
        new AIMessage("result"),
      ],
    });
    const toolNode = new ToolNode([new SearchAPI()]);
    const agent = createReactAgent({
      llm,
      tools: toolNode,
    });
    const result = await agent.invoke({
      messages: [new HumanMessage("Hello Input!")],
    });
    const expected = [
      new _AnyIdHumanMessage("Hello Input!"),
      new _AnyIdAIMessage({
        content: "",
        tool_calls: [
          {
            name: "search_api",
            id: "tool_abcd123",
            args: { query: "foo" },
          },
        ],
      }),
      new _AnyIdToolMessage({
        name: "search_api",
        content: "result for foo",
        tool_call_id: "tool_abcd123",
      }),
      new _AnyIdAIMessage("result"),
    ];
    expect(result.messages).toEqual(expected);
  });
  it("Should work with ToolNode with handleToolErrors set to false", async () => {
    const llm = new FakeToolCallingChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              name: "search_api",
              id: "tool_abcd123",
              args: { query: "error" },
            },
          ],
        }),
      ],
    });
    const toolNode = new ToolNode([new SearchAPI()], {
      handleToolErrors: false,
    });
    const agentNoErrorHandling = createReactAgent({
      llm,
      tools: toolNode,
    });
    await expect(
      agentNoErrorHandling.invoke({
        messages: [new HumanMessage("Hello Input!")],
      })
    ).rejects.toThrow();
  });
  it("should work with interrupt()", async () => {
    const toolWithInterrupt = tool(
      async (_) => {
        const value = interrupt("Please review.");
        return value;
      },
      {
        name: "tool_with_interrupt",
        description: "A tool that returns an interrupt",
        schema: z.object({}),
      }
    );
    const llm = new FakeToolCallingChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [{ name: "tool_with_interrupt", args: {}, id: "testid" }],
        }),
        new AIMessage("Final response"),
      ],
    });

    // base case (ensure that GraphInterrupt is raised under the hood)
    const agent = createReactAgent({
      llm,
      tools: [toolWithInterrupt],
      checkpointer: new MemorySaver(),
    });
    const res = await agent.invoke(
      { messages: [new HumanMessage("Hello Input!")] },
      { configurable: { thread_id: "1" } }
    );
    // only 2 messages before the interrupt
    expect(res.messages.length).toEqual(2);
    const resResume = await agent.invoke(new Command({ resume: "Approved." }), {
      configurable: { thread_id: "1" },
    });
    expect(resResume.messages.length).toEqual(4);
    expect(resResume.messages[2].content).toEqual("Approved.");

    // confirm that it works with disabled tool error handling as well
    const toolNodeNoErrorHandling = new ToolNode([toolWithInterrupt], {
      handleToolErrors: false,
    });
    const agentNoErrorHandling = createReactAgent({
      llm,
      tools: toolNodeNoErrorHandling,
      checkpointer: new MemorySaver(),
    });
    const resNoErrorHandling = await agentNoErrorHandling.invoke(
      { messages: [new HumanMessage("Hello Input!")] },
      { configurable: { thread_id: "1" } }
    );
    // only 2 messages before the interrupt
    expect(resNoErrorHandling.messages.length).toEqual(2);
    const resNoErrorHandlingResume = await agentNoErrorHandling.invoke(
      new Command({ resume: "Approved." }),
      { configurable: { thread_id: "1" } }
    );
    expect(resNoErrorHandlingResume.messages.length).toEqual(4);
    expect(resNoErrorHandlingResume.messages[2].content).toEqual("Approved.");
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

describe("createReactAgent with structured responses", () => {
  it("Basic structured response", async () => {
    // Define a schema for the structured response
    const weatherResponseSchema = z.object({
      temperature: z.number().describe("The temperature in fahrenheit"),
    });

    const expectedStructuredResponse = { temperature: 75 };

    // Create a fake model that returns tool calls and a structured response
    const llm = new FakeToolCallingChatModel({
      responses: [
        new AIMessage({
          content: "Checking the weather",
          tool_calls: [
            {
              name: "get_weather",
              id: "1",
              args: {},
            },
          ],
        }),
        new AIMessage("The weather is nice"),
      ],
      structuredResponse: expectedStructuredResponse,
    });

    // Define a simple weather tool
    const getWeather = tool(async () => "The weather is sunny and 75°F.", {
      name: "get_weather",
      description: "Get the weather",
      schema: z.object({}),
    });

    // Test with just the schema
    const agent1 = createReactAgent({
      llm,
      tools: [getWeather],
      responseFormat: weatherResponseSchema,
    });

    const result1 = await agent1.invoke({
      messages: [new HumanMessage("What's the weather?")],
    });

    // Check agent output
    expect(result1.structuredResponse).toEqual(expectedStructuredResponse);
    expect(result1.messages.length).toEqual(4);
    expect(result1.messages[2].content).toEqual(
      "The weather is sunny and 75°F."
    );

    // Check messages sent to model for structured response generation
    expect(llm.structuredOutputMessages.length).toEqual(1);
    expect(llm.structuredOutputMessages[0].length).toEqual(4);
    expect(llm.structuredOutputMessages[0][0].content).toEqual(
      "What's the weather?"
    );
    expect(llm.structuredOutputMessages[0][1].content).toEqual(
      "Checking the weather"
    );
    expect(llm.structuredOutputMessages[0][2].content).toEqual(
      "The weather is sunny and 75°F."
    );
    expect(llm.structuredOutputMessages[0][3].content).toEqual(
      "The weather is nice"
    );

    // Test with prompt and schema
    const agent2 = createReactAgent({
      llm,
      tools: [getWeather],
      responseFormat: {
        prompt: "Meow",
        schema: weatherResponseSchema,
      },
    });

    const result2 = await agent2.invoke({
      messages: [new HumanMessage("What's the weather?")],
    });

    expect(result2.structuredResponse).toEqual(expectedStructuredResponse);
    expect(result2.messages.length).toEqual(4);
    expect(result2.messages[2].content).toEqual(
      "The weather is sunny and 75°F."
    );

    // Check messages sent to model for structured response generation
    expect(llm.structuredOutputMessages.length).toEqual(2);
    expect(llm.structuredOutputMessages[1].length).toEqual(5);
    expect(llm.structuredOutputMessages[1][0].content).toEqual("Meow");
    expect(llm.structuredOutputMessages[1][1].content).toEqual(
      "What's the weather?"
    );
    expect(llm.structuredOutputMessages[1][2].content).toEqual(
      "Checking the weather"
    );
    expect(llm.structuredOutputMessages[1][3].content).toEqual(
      "The weather is sunny and 75°F."
    );
    expect(llm.structuredOutputMessages[1][4].content).toEqual(
      "The weather is nice"
    );
  });
});

describe("_shouldBindTools", () => {
  it.each(["openai", "anthropic", "google", "bedrock"] as const)(
    "Should determine when to bind tools - %s style",
    async (toolStyle) => {
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

      const model = new FakeToolCallingChatModel({
        responses: [new AIMessage("test")],
        toolStyle,
      });

      // Should bind when a regular model
      expect(_shouldBindTools(model, [])).toBe(true);
      expect(_shouldBindTools(model, [tool1])).toBe(true);

      // Should bind when a seq
      const seq = RunnableSequence.from([
        model,
        RunnableLambda.from((message) => message),
      ]);
      expect(_shouldBindTools(seq, [])).toBe(true);
      expect(_shouldBindTools(seq, [tool1])).toBe(true);

      // Should not bind when a model with tools
      const modelWithTools = model.bindTools([tool1]);
      expect(_shouldBindTools(modelWithTools, [tool1])).toBe(false);

      // Should not bind when a seq with tools
      const seqWithTools = RunnableSequence.from([
        model.bindTools([tool1]),
        RunnableLambda.from((message) => message),
      ]);
      expect(_shouldBindTools(seqWithTools, [tool1])).toBe(false);

      // Should raise on invalid inputs
      expect(() => _shouldBindTools(model.bindTools([tool1]), [])).toThrow();
      expect(() =>
        _shouldBindTools(model.bindTools([tool1]), [tool2])
      ).toThrow();
      expect(() =>
        _shouldBindTools(model.bindTools([tool1]), [tool1, tool2])
      ).toThrow();
    }
  );
});

describe("_getModel", () => {
  it("Should extract the model from different inputs", async () => {
    const model = new FakeToolCallingChatModel({
      responses: [new AIMessage("test")],
    });
    expect(_getModel(model)).toBe(model);

    const tool1 = tool((input) => `Tool 1: ${input.someVal}`, {
      name: "tool1",
      description: "Tool 1 docstring.",
      schema: z.object({
        someVal: z.number().describe("Input value"),
      }),
    });

    const modelWithTools = model.bindTools([tool1]);
    expect(_getModel(modelWithTools)).toBe(model);

    const seq = RunnableSequence.from([
      model,
      RunnableLambda.from((message) => message),
    ]);
    expect(_getModel(seq)).toBe(model);

    const seqWithTools = RunnableSequence.from([
      model.bindTools([tool1]),
      RunnableLambda.from((message) => message),
    ]);
    expect(_getModel(seqWithTools)).toBe(model);

    const raisingSeq = RunnableSequence.from([
      RunnableLambda.from((message) => message),
      RunnableLambda.from((message) => message),
    ]);
    expect(() => _getModel(raisingSeq)).toThrow(Error);
  });
});

describe("ToolNode with Commands", () => {
  it("can handle tools returning commands with dict input", async () => {
    // Tool that returns a Command
    const transferToBob = tool(
      async (_, config) => {
        return new Command({
          update: {
            messages: [
              new ToolMessage({
                content: "Transferred to Bob",
                tool_call_id: config.toolCall.id,
                name: "transfer_to_bob",
              }),
            ],
          },
          goto: "bob",
          graph: Command.PARENT,
        });
      },
      {
        name: "transfer_to_bob",
        description: "Transfer to Bob",
        schema: z.object({}),
      }
    );

    // Async version of the tool
    const asyncTransferToBob = tool(
      async (_, config) => {
        return new Command({
          update: {
            messages: [
              new ToolMessage({
                content: "Transferred to Bob",
                tool_call_id: config.toolCall.id,
                name: "async_transfer_to_bob",
              }),
            ],
          },
          goto: "bob",
          graph: Command.PARENT,
        });
      },
      {
        name: "async_transfer_to_bob",
        description: "Transfer to Bob",
        schema: z.object({}),
      }
    );

    // Basic tool that doesn't return a Command
    const add = tool(({ a, b }) => `${a + b}`, {
      name: "add",
      description: "Add two numbers",
      schema: z.object({
        a: z.number(),
        b: z.number(),
      }),
    });

    // Test mixing regular tools and tools returning commands

    // Test with dict input
    const result = await new ToolNode([add, transferToBob]).invoke({
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [
            { args: { a: 1, b: 2 }, id: "1", name: "add", type: "tool_call" },
            { args: {}, id: "2", name: "transfer_to_bob", type: "tool_call" },
          ],
        }),
      ],
    });

    expect(result).toEqual([
      {
        messages: [
          new ToolMessage({
            content: "3",
            tool_call_id: "1",
            name: "add",
          }),
        ],
      },
      new Command({
        update: {
          messages: [
            new ToolMessage({
              content: "Transferred to Bob",
              tool_call_id: "2",
              name: "transfer_to_bob",
            }),
          ],
        },
        goto: "bob",
        graph: Command.PARENT,
      }),
    ]);

    // Test single tool returning command
    const singleToolResult = await new ToolNode([transferToBob]).invoke({
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [{ args: {}, id: "1", name: "transfer_to_bob" }],
        }),
      ],
    });

    expect(singleToolResult).toEqual([
      new Command({
        update: {
          messages: [
            new ToolMessage({
              content: "Transferred to Bob",
              tool_call_id: "1",
              name: "transfer_to_bob",
            }),
          ],
        },
        goto: "bob",
        graph: Command.PARENT,
      }),
    ]);

    // Test async tool
    const asyncToolResult = await new ToolNode([asyncTransferToBob]).invoke({
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [{ args: {}, id: "1", name: "async_transfer_to_bob" }],
        }),
      ],
    });

    expect(asyncToolResult).toEqual([
      new Command({
        update: {
          messages: [
            new ToolMessage({
              content: "Transferred to Bob",
              tool_call_id: "1",
              name: "async_transfer_to_bob",
            }),
          ],
        },
        goto: "bob",
        graph: Command.PARENT,
      }),
    ]);

    // Test multiple commands
    const multipleCommandsResult = await new ToolNode([
      transferToBob,
      asyncTransferToBob,
    ]).invoke({
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [
            { args: {}, id: "1", name: "transfer_to_bob" },
            { args: {}, id: "2", name: "async_transfer_to_bob" },
          ],
        }),
      ],
    });

    expect(multipleCommandsResult).toEqual([
      new Command({
        update: {
          messages: [
            new ToolMessage({
              content: "Transferred to Bob",
              tool_call_id: "1",
              name: "transfer_to_bob",
            }),
          ],
        },
        goto: "bob",
        graph: Command.PARENT,
      }),
      new Command({
        update: {
          messages: [
            new ToolMessage({
              content: "Transferred to Bob",
              tool_call_id: "2",
              name: "async_transfer_to_bob",
            }),
          ],
        },
        goto: "bob",
        graph: Command.PARENT,
      }),
    ]);
  });

  it("can handle tools returning commands with array input", async () => {
    // Tool that returns a Command with array update
    const transferToBob = tool(
      async (_, config) => {
        return new Command({
          update: [
            // @ts-expect-error: Command typing needs to be updated properly
            new ToolMessage({
              content: "Transferred to Bob",
              tool_call_id: config.toolCall.id,
              name: "transfer_to_bob",
            }),
          ],
          goto: "bob",
          graph: Command.PARENT,
        });
      },
      {
        name: "transfer_to_bob",
        description: "Transfer to Bob",
        schema: z.object({}),
      }
    );

    // Async version of the tool
    const asyncTransferToBob = tool(
      async (_, config) => {
        return new Command({
          update: [
            // @ts-expect-error: Command typing needs to be updated properly
            new ToolMessage({
              content: "Transferred to Bob",
              tool_call_id: config.toolCall.id,
              name: "async_transfer_to_bob",
            }),
          ],
          goto: "bob",
          graph: Command.PARENT,
        });
      },
      {
        name: "async_transfer_to_bob",
        description: "Transfer to Bob",
        schema: z.object({}),
      }
    );

    // Basic tool that doesn't return a Command
    const add = tool(({ a, b }) => `${a + b}`, {
      name: "add",
      description: "Add two numbers",
      schema: z.object({
        a: z.number(),
        b: z.number(),
      }),
    });

    // Test with array input
    const result = await new ToolNode([add, transferToBob]).invoke([
      new AIMessage({
        content: "",
        tool_calls: [
          { args: { a: 1, b: 2 }, id: "1", name: "add" },
          { args: {}, id: "2", name: "transfer_to_bob" },
        ],
      }),
    ]);

    expect(result).toEqual([
      [
        new ToolMessage({
          content: "3",
          tool_call_id: "1",
          name: "add",
        }),
      ],
      new Command({
        update: [
          // @ts-expect-error: Command typing needs to be updated properly
          new ToolMessage({
            content: "Transferred to Bob",
            tool_call_id: "2",
            name: "transfer_to_bob",
          }),
        ],
        goto: "bob",
        graph: Command.PARENT,
      }),
    ]);

    // Test single tool returning command
    for (const tool of [transferToBob, asyncTransferToBob]) {
      const result = await new ToolNode([tool]).invoke([
        new AIMessage({
          content: "",
          tool_calls: [{ args: {}, id: "1", name: tool.name }],
        }),
      ]);

      expect(result).toEqual([
        new Command({
          update: [
            // @ts-expect-error: Command typing needs to be updated properly
            new ToolMessage({
              content: "Transferred to Bob",
              tool_call_id: "1",
              name: tool.name,
            }),
          ],
          goto: "bob",
          graph: Command.PARENT,
        }),
      ]);
    }

    // Test multiple commands
    const multipleCommandsResult = await new ToolNode([
      transferToBob,
      asyncTransferToBob,
    ]).invoke([
      new AIMessage({
        content: "",
        tool_calls: [
          { args: {}, id: "1", name: "transfer_to_bob" },
          { args: {}, id: "2", name: "async_transfer_to_bob" },
        ],
      }),
    ]);

    expect(multipleCommandsResult).toEqual([
      new Command({
        update: [
          // @ts-expect-error: Command typing needs to be updated properly
          new ToolMessage({
            content: "Transferred to Bob",
            tool_call_id: "1",
            name: "transfer_to_bob",
          }),
        ],
        goto: "bob",
        graph: Command.PARENT,
      }),
      new Command({
        update: [
          // @ts-expect-error: Command typing needs to be updated properly
          new ToolMessage({
            content: "Transferred to Bob",
            tool_call_id: "2",
            name: "async_transfer_to_bob",
          }),
        ],
        goto: "bob",
        graph: Command.PARENT,
      }),
    ]);
  });

  it("should handle parent commands with Send", async () => {
    // Create tools that return Commands with Send
    const transferToAlice = tool(
      async (_, config) => {
        return new Command({
          goto: [
            new Send("alice", {
              messages: [
                new ToolMessage({
                  content: "Transferred to Alice",
                  name: "transfer_to_alice",
                  tool_call_id: config.toolCall.id,
                }),
              ],
            }),
          ],
          graph: Command.PARENT,
        });
      },
      {
        name: "transfer_to_alice",
        description: "Transfer to Alice",
        schema: z.object({}),
      }
    );

    const transferToBob = tool(
      async (_, config) => {
        return new Command({
          goto: [
            new Send("bob", {
              messages: [
                new ToolMessage({
                  content: "Transferred to Bob",
                  name: "transfer_to_bob",
                  tool_call_id: config.toolCall.id,
                }),
              ],
            }),
          ],
          graph: Command.PARENT,
        });
      },
      {
        name: "transfer_to_bob",
        description: "Transfer to Bob",
        schema: z.object({}),
      }
    );

    const result = await new ToolNode([transferToAlice, transferToBob]).invoke([
      new AIMessage({
        content: "",
        tool_calls: [
          { args: {}, id: "1", name: "transfer_to_alice", type: "tool_call" },
          { args: {}, id: "2", name: "transfer_to_bob", type: "tool_call" },
        ],
      }),
    ]);

    expect(result).toEqual([
      new Command({
        goto: [
          new Send("alice", {
            messages: [
              new ToolMessage({
                content: "Transferred to Alice",
                name: "transfer_to_alice",
                tool_call_id: "1",
              }),
            ],
          }),
          new Send("bob", {
            messages: [
              new ToolMessage({
                content: "Transferred to Bob",
                name: "transfer_to_bob",
                tool_call_id: "2",
              }),
            ],
          }),
        ],
        graph: Command.PARENT,
      }),
    ]);
  });
});
describe("ToolNode should raise GraphInterrupt", () => {
  it("should raise GraphInterrupt", async () => {
    const toolWithInterrupt = tool(
      async (_) => {
        throw new GraphInterrupt();
      },
      {
        name: "tool_with_interrupt",
        description: "A tool that returns an interrupt",
        schema: z.object({}),
      }
    );
    const toolNode = new ToolNode([toolWithInterrupt]);
    await expect(
      toolNode.invoke({
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              { name: "tool_with_interrupt", args: {}, id: "testid" },
            ],
          }),
        ],
      })
    ).rejects.toThrow(GraphInterrupt);
  });
});
