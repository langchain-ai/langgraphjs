/* eslint-disable no-process-env */
/* eslint-disable no-param-reassign */
/* eslint-disable no-return-assign */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { StructuredTool, tool } from "@langchain/core/tools";

import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  isAIMessage,
  RemoveMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { z } from "zod/v3";
import { z as z4 } from "zod/v4";
import {
  Runnable,
  RunnableLambda,
  RunnableSequence,
} from "@langchain/core/runnables";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import {
  _AnyIdAIMessage,
  _AnyIdHumanMessage,
  _AnyIdToolMessage,
  getReadableMermaid,
  MemorySaverAssertImmutable,
} from "./utils.js";
import {
  FakeConfigurableModel,
  FakeToolCallingChatModel,
} from "./utils.models.js";
import { ToolNode, createReactAgent } from "../prebuilt/index.js";
import {
  _shouldBindTools,
  _getModel,
  _bindTools,
} from "../prebuilt/react_agent_executor.js";
// Enable automatic config passing
import {
  Annotation,
  Command,
  getCurrentTaskInput,
  GraphInterrupt,
  interrupt,
  MemorySaver,
  messagesStateReducer,
  REMOVE_ALL_MESSAGES,
  Runtime,
  Send,
  StateGraph,
} from "../index.js";
import {
  MessagesAnnotation,
  MessagesZodMeta,
  MessagesZodState,
} from "../graph/messages_annotation.js";
import { gatherIterator } from "../utils.js";
import { withLangGraph } from "../graph/zod/meta.js";
import { registry } from "../graph/zod/zod-registry.js";

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

describe.each([["v1" as const], ["v2" as const]])(
  "createReactAgent (version %s)",
  (version) => {
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
          version,
          prompt: "You are a helpful assistant",
        });

        const agent2 = createReactAgent({
          llm,
          tools,
          version,
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
          version,
          prompt: new SystemMessage("You are a helpful assistant"),
        });

        const agent2 = createReactAgent({
          llm,
          tools,
          version,
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
          version,
          prompt: (state) => [new AIMessage("foobar"), ...state.messages],
        });

        const agent2 = createReactAgent({
          llm,
          tools,
          version,
          stateModifier: (state) => [
            new AIMessage("foobar"),
            ...state.messages,
          ],
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
            tool(async () => new Command({ update: { foo: "baz" } }), {
              name: "test",
              schema: z.object({}),
            }),
          ],
          version,
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

      it("Throws if messages is not in state schema", async () => {
        const llm = new FakeToolCallingChatModel({});

        // Annotation
        expect
          .soft(() =>
            createReactAgent({
              llm,
              tools: [],
              version,
              stateSchema: Annotation.Root({ flag: Annotation<boolean> }),
            })
          )
          .toThrowError("Missing required `messages` key in state schema.");

        // Zod 3
        expect
          .soft(() =>
            createReactAgent({
              llm,
              tools: [],
              version,
              stateSchema: z.object({ flag: z.boolean() }),
            })
          )
          .toThrowError("Missing required `messages` key in state schema.");

        // Zod 4
        expect
          .soft(() =>
            createReactAgent({
              llm,
              tools: [],
              version,
              stateSchema: z4.object({ flag: z4.boolean() }),
            })
          )
          .toThrowError("Missing required `messages` key in state schema.");
      });

      it("Allows custom Zod 4 state schema", async () => {
        const llm = new FakeToolCallingChatModel({
          responses: [
            new AIMessage({
              content: "result1",
              tool_calls: [{ id: "test1234", args: {}, name: "test" }],
            }),
            new AIMessage("result2"),
          ],
        });

        const agent = createReactAgent({
          llm,
          tools: [
            tool(async () => new Command({ update: { foo: "baz" } }), {
              name: "test",
              schema: z.object({}),
            }),
          ],
          version,
          stateSchema: z4.object({
            messages: z4
              .custom<BaseMessage[]>()
              .register(registry, MessagesZodMeta),
            foo: z4.string(),
          }),
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
          version,
          prompt: "You are a helpful assistant",
        });

        const controller = new AbortController();

        setTimeout(() => controller.abort(), 100);

        await expect(async () => {
          await agent.invoke(
            { messages: [new HumanMessage("Hello Input!")] },
            { signal: controller.signal }
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
          version,
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
              {
                name: "search_api",
                id: "tool_abcd123",
                args: { query: "foo" },
              },
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
          version,
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
              {
                name: "search_api",
                id: "tool_abcd123",
                args: { query: "foo" },
              },
            ],
          }),
          new _AnyIdToolMessage({
            name: "search_api",
            status: "success",
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
            version,
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

          const toolMessages = (
            (result?.messages as BaseMessage[]) || []
          ).slice(-2) as ToolMessage[];
          for (const toolMessage of toolMessages) {
            expect(toolMessage._getType()).toBe("tool");
            expect(["Tool 1: 2", "Tool 2: 2"]).toContain(toolMessage.content);
            expect(["some 1", "some 2"]).toContain(toolMessage.tool_call_id);
          }

          // Test mismatching tool lengths
          await expect(async () => {
            const agent = createReactAgent({
              llm: llm.bindTools([tool1]),
              tools: [tool1, tool2],
              version,
            });
            await agent.invoke({
              messages: [new HumanMessage("Hello Input!")],
            });
          }).rejects.toThrow();

          // Test missing bound tools
          await expect(async () => {
            const agent = createReactAgent({
              llm: llm.bindTools([tool1]),
              tools: [tool2],
              version,
            });
            await agent.invoke({
              messages: [new HumanMessage("Hello Input!")],
            });
          }).rejects.toThrow();
        }
      );
    });

    describe("createReactAgent agent name options", () => {
      it("Can use inline agent name", async () => {
        const responses = [
          new AIMessage("Hello, how can I help?"),
          new AIMessage("Hmm, I'm not sure about that."),
        ];
        const llm = new FakeToolCallingChatModel({ responses });
        const invokeSpy = vi.spyOn(llm, "invoke");
        const agent = createReactAgent({
          llm,
          tools: [new SearchAPI()],
          version,
          includeAgentName: "inline",
          name: "test agent",
        });

        const messages: BaseMessage[] = [new HumanMessage("Hello!")];
        const result1 = await agent.invoke({ messages });
        const outputMessage1 = result1.messages.at(-1) as AIMessage;
        messages.push(outputMessage1);

        expect(outputMessage1.name).toBe("test agent");
        expect(outputMessage1.content).toBe("Hello, how can I help?");

        const result2 = await agent.invoke({ messages });
        const outputMessage2 = result2.messages.at(-1) as AIMessage;

        expect(invokeSpy).toHaveBeenLastCalledWith(
          [
            messages[0],
            new _AnyIdAIMessage({
              // no name on input message
              name: undefined,
              // xml formatting on input message
              content:
                "<name>test agent</name><content>Hello, how can I help?</content>",
            }),
          ],
          expect.objectContaining({})
        );

        // name applied on returned output
        expect(outputMessage2.name).toBe("test agent");

        // no xml formatting on returned output
        expect(outputMessage2.content).toBe("Hmm, I'm not sure about that.");
      });

      it("Can use inline agent name with content blocks", async () => {
        const responses = [
          new AIMessage({
            content: [{ type: "text", text: "Hello, how can I help?" }],
          }),
          new AIMessage({
            content: [{ type: "text", text: "Hmm, I'm not sure about that." }],
          }),
        ];
        const llm = new FakeToolCallingChatModel({ responses });
        const invokeSpy = vi.spyOn(llm, "invoke");

        const agent = createReactAgent({
          llm,
          tools: [new SearchAPI()],
          version,
          includeAgentName: "inline",
          name: "test agent",
        });

        const messages: BaseMessage[] = [new HumanMessage("Hello!")];
        const result1 = await agent.invoke({ messages });
        const outputMessage1 = result1.messages.at(-1) as AIMessage;
        messages.push(outputMessage1);

        expect(outputMessage1.name).toBe("test agent");
        expect(outputMessage1.content).toEqual([
          { type: "text", text: "Hello, how can I help?" },
        ]);

        const result2 = await agent.invoke({ messages });
        const outputMessage2 = result2.messages.at(-1) as AIMessage;

        expect(invokeSpy).toHaveBeenLastCalledWith(
          [
            messages[0],
            new _AnyIdAIMessage({
              // no name on input message
              name: undefined,
              // xml formatting on input message
              content: [
                {
                  type: "text",
                  text: "<name>test agent</name><content>Hello, how can I help?</content>",
                },
              ],
            }),
          ],
          expect.objectContaining({})
        );

        // name applied on returned output
        expect(outputMessage2.name).toBe("test agent");

        // no xml formatting on returned output
        expect(outputMessage2.content).toEqual([
          { type: "text", text: "Hmm, I'm not sure about that." },
        ]);
      });

      it("Sets name when includeAgentName is undefined", async () => {
        const responses = [
          new AIMessage("Hello, how can I help?"),
          new AIMessage("Hmm, I'm not sure about that."),
        ];
        const llm = new FakeToolCallingChatModel({ responses });
        const invokeSpy = vi.spyOn(llm, "invoke");
        const agent = createReactAgent({
          llm,
          tools: [new SearchAPI()],
          version,
          // includeAgentName: undefined
          name: "test agent",
        });

        const messages: BaseMessage[] = [new HumanMessage("Hello!")];
        const result1 = await agent.invoke({ messages });
        const outputMessage1 = result1.messages.at(-1) as AIMessage;
        messages.push(outputMessage1);

        expect(outputMessage1.name).toBe("test agent");
        expect(outputMessage1.content).toBe("Hello, how can I help?");

        const result2 = await agent.invoke({ messages });
        const outputMessage2 = result2.messages.at(-1) as AIMessage;

        expect(invokeSpy).toHaveBeenLastCalledWith(
          [
            messages[0],
            new _AnyIdAIMessage({
              // name is set to "test agent"
              name: "test agent",
              // no xml formatting on input message
              content: "Hello, how can I help?",
            }),
          ],
          expect.objectContaining({})
        );

        // name applied on returned output
        expect(outputMessage2.name).toBe("test agent");

        // no xml formatting on returned output
        expect(outputMessage2.content).toBe("Hmm, I'm not sure about that.");
      });
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
          version,
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
          version,
          messageModifier: new SystemMessage("You are a helpful assistant"),
        });

        const result = await agent.invoke({
          messages: [],
        });
        const expected = [
          new _AnyIdAIMessage({
            content: "result1",
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
          version,
          messageModifier: (messages) => [new AIMessage("foobar"), ...messages],
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
          version,
          messageModifier: "You are a helpful assistant",
        });

        const controller = new AbortController();

        setTimeout(() => controller.abort(), 100);

        await expect(async () => {
          await agent.invoke(
            { messages: [new HumanMessage("Hello Input!")] },
            { signal: controller.signal }
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
          version,
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
              {
                name: "search_api",
                id: "tool_abcd123",
                args: { query: "foo" },
              },
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
          version,
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
              {
                name: "search_api",
                id: "tool_abcd123",
                args: { query: "foo" },
              },
            ],
          }),
          new _AnyIdToolMessage({
            status: "success",
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
          version,
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
          version,
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
              tool_calls: [
                { name: "tool_with_interrupt", args: {}, id: "testid" },
              ],
            }),
            new AIMessage("Final response"),
          ],
        });

        // base case (ensure that GraphInterrupt is raised under the hood)
        const agent = createReactAgent({
          llm,
          tools: [toolWithInterrupt],
          version,
          checkpointer: new MemorySaver(),
        });
        const res = await agent.invoke(
          { messages: [new HumanMessage("Hello Input!")] },
          { configurable: { thread_id: "1" } }
        );
        // only 2 messages before the interrupt
        expect(res.messages.length).toEqual(2);
        const resResume = await agent.invoke(
          new Command({ resume: "Approved." }),
          {
            configurable: { thread_id: "1" },
          }
        );
        expect(resResume.messages.length).toEqual(4);
        expect(resResume.messages[2].content).toEqual("Approved.");

        // confirm that it works with disabled tool error handling as well
        const toolNodeNoErrorHandling = new ToolNode([toolWithInterrupt], {
          handleToolErrors: false,
        });
        const agentNoErrorHandling = createReactAgent({
          llm,
          tools: toolNodeNoErrorHandling,
          version,
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
        expect(resNoErrorHandlingResume.messages[2].content).toEqual(
          "Approved."
        );
      });
    });

    describe("createReactAgent with hooks", () => {
      it("preModelHook", async () => {
        const llm = new FakeToolCallingChatModel({
          responses: [
            new AIMessage({ id: "0", content: "Hello!" }),
            new AIMessage({ id: "1", content: "Hello again!" }),
          ],
        });
        const llmSpy = vi.spyOn(llm, "_generate");
        const checkpointer = new MemorySaver();

        // Test `llm_input_messages`
        let agent = createReactAgent({
          llm,
          tools: [],
          preModelHook: () => ({ llmInputMessages: "pre-hook" }),
          checkpointer,
          version,
        });

        expect("pre_model_hook" in agent.nodes).toBe(true);
        expect(
          await agent.invoke(
            { messages: [new HumanMessage("hi?")] },
            { configurable: { thread_id: "1" } }
          )
        ).toEqual({
          messages: [
            new _AnyIdHumanMessage("hi?"),
            new AIMessage({ id: "0", content: "Hello!" }),
          ],
        });

        expect(llmSpy).toHaveBeenCalledWith(
          [new _AnyIdHumanMessage({ content: "pre-hook" })],
          expect.anything(),
          undefined
        );

        llmSpy.mockClear();

        // Second invocation
        expect(
          await agent.invoke(
            { messages: [new HumanMessage("hi again")] },
            { configurable: { thread_id: "1" } }
          )
        ).toEqual({
          messages: [
            new _AnyIdHumanMessage("hi?"),
            new AIMessage({ id: "0", content: "Hello!" }),
            new _AnyIdHumanMessage("hi again"),
            new AIMessage({ id: "1", content: "Hello again!" }),
          ],
        });

        expect(llmSpy).toHaveBeenCalledWith(
          [new _AnyIdHumanMessage("pre-hook")],
          expect.anything(),
          undefined
        );

        // Test `messages`
        agent = createReactAgent({
          llm,
          tools: [],
          version,
          preModelHook: () => ({
            messages: [
              new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
              new HumanMessage("Hello!"),
            ],
          }),
        });

        expect("pre_model_hook" in agent.nodes).toBe(true);
        expect(
          await agent.invoke({ messages: [new HumanMessage("hi?")] })
        ).toEqual({
          messages: [
            new _AnyIdHumanMessage("Hello!"),
            new AIMessage({ id: "0", content: "Hello!" }),
          ],
        });
      });

      it("preModelHook + Zod 3 + postModelHook", async () => {
        const llm = new FakeToolCallingChatModel({
          responses: [new AIMessage({ id: "0", content: "Hello!" })],
        });

        const llmSpy = vi.spyOn(llm, "_generate");

        const agent = createReactAgent({
          llm,
          tools: [],
          version,
          preModelHook: () => ({
            llmInputMessages: [
              new HumanMessage({ id: "human", content: "pre-hook" }),
            ],
          }),
          stateSchema: z.object({
            messages: withLangGraph(z.custom<BaseMessage[]>(), MessagesZodMeta),
            flag: withLangGraph(z.boolean(), {
              reducer: {
                fn: (a, b) =>
                  [a, ...b].reduce((acc, curr) => acc || curr, false),
                schema: z.array(z.boolean()),
              },
              default: () => false,
            }),
          }),
          postModelHook: () => ({ flag: [false, false, true] }),
        });

        expect(
          await agent.invoke({ messages: [new HumanMessage("hi?")] })
        ).toEqual({
          messages: [
            new _AnyIdHumanMessage("hi?"),
            new AIMessage({ id: "0", content: "Hello!" }),
          ],
          flag: true,
        });

        expect(llmSpy).toHaveBeenCalledWith(
          [new HumanMessage({ id: "human", content: "pre-hook" })],
          expect.anything(),
          undefined
        );
      });

      it("preModelHook + Zod 4 + postModelHook", async () => {
        const llm = new FakeToolCallingChatModel({
          responses: [new AIMessage({ id: "0", content: "Hello!" })],
        });

        const llmSpy = vi.spyOn(llm, "_generate");

        const agent = createReactAgent({
          llm,
          tools: [],
          version,
          preModelHook: () => ({
            llmInputMessages: [
              new HumanMessage({ id: "human", content: "pre-hook" }),
            ],
          }),
          stateSchema: z4.object({
            messages: z4
              .custom<BaseMessage[]>()
              .register(registry, MessagesZodMeta),
            flag: z4.boolean().register(registry, {
              reducer: {
                fn: (a, b) =>
                  [a, ...b].reduce((acc, curr) => acc || curr, false),
                schema: z.array(z.boolean()),
              },
              default: () => false,
            }),
          }),
          postModelHook: () => ({ flag: [false, false, true] }),
        });

        expect(
          await agent.invoke({ messages: [new HumanMessage("hi?")] })
        ).toEqual({
          messages: [
            new _AnyIdHumanMessage("hi?"),
            new AIMessage({ id: "0", content: "Hello!" }),
          ],
          flag: true,
        });

        expect(llmSpy).toHaveBeenCalledWith(
          [new HumanMessage({ id: "human", content: "pre-hook" })],
          expect.anything(),
          undefined
        );
      });

      it("postModelHook", async () => {
        const FlagAnnotation = Annotation.Root({
          ...MessagesAnnotation.spec,
          flag: Annotation<boolean>,
        });

        const llm = new FakeToolCallingChatModel({
          responses: [new AIMessage({ id: "1", content: "hi?" })],
        });

        const agent = createReactAgent({
          llm,
          tools: [],
          version,
          postModelHook: () => ({ flag: true }),
          stateSchema: FlagAnnotation,
        });

        expect("post_model_hook" in agent.nodes).toBe(true);
        expect(
          await agent.invoke({
            messages: [new HumanMessage("hi?")],
            flag: false,
          })
        ).toMatchObject({ flag: true });

        expect(
          await gatherIterator(
            agent.stream({
              messages: [new HumanMessage("hi?")],
              flag: false,
            })
          )
        ).toMatchObject([
          {
            agent: {
              messages: [new AIMessage({ id: "1", content: "hi?" })],
            },
          },
          { post_model_hook: { flag: true } },
        ]);
      });

      it("postModelHook + structured response", async () => {
        const weatherResponseSchema = z.object({
          temperature: z.number().describe("The temperature in fahrenheit"),
        });

        const FlagAnnotation = Annotation.Root({
          ...MessagesAnnotation.spec,
          flag: Annotation<boolean>,
          structuredResponse: Annotation<z.infer<typeof weatherResponseSchema>>,
        });

        const llm = new FakeToolCallingChatModel({
          responses: [
            new AIMessage({
              id: "1",
              content: "What's the weather?",
              tool_calls: [
                {
                  name: "get_weather",
                  args: {},
                  id: "1",
                  type: "tool_call",
                },
              ],
            }),
            new AIMessage({ id: "3", content: "The weather is nice" }),
          ],
          structuredResponse: { temperature: 75 },
        });

        const getWeather = tool(async () => "The weather is sunny and 75°F.", {
          name: "get_weather",
          description: "Get the weather",
          schema: z.object({}),
        });

        const agent = createReactAgent({
          llm,
          tools: [getWeather],
          version,
          responseFormat: weatherResponseSchema,
          postModelHook: () => ({ flag: true }),
          stateSchema: FlagAnnotation,
        });

        expect("post_model_hook" in agent.nodes).toBe(true);
        expect("generate_structured_response" in agent.nodes).toBe(true);

        const response = await agent.invoke({
          messages: [
            new HumanMessage({ id: "0", content: "What's the weather?" }),
          ],
          flag: false,
        });

        expect(response).toMatchObject({
          flag: true,
          structuredResponse: { temperature: 75 },
        });

        expect(
          await gatherIterator(
            agent.stream({
              messages: [
                new HumanMessage({ id: "0", content: "What's the weather?" }),
              ],
              flag: false,
            })
          )
        ).toEqual([
          {
            agent: {
              messages: [
                new AIMessage({
                  content: "What's the weather?",
                  id: "1",
                  tool_calls: [
                    {
                      name: "get_weather",
                      args: {},
                      id: "1",
                      type: "tool_call",
                    },
                  ],
                }),
              ],
            },
          },
          { post_model_hook: { flag: true } },
          {
            tools: {
              messages: [
                new _AnyIdToolMessage({
                  content: "The weather is sunny and 75°F.",
                  name: "get_weather",
                  tool_call_id: "1",
                }),
              ],
            },
          },
          {
            agent: {
              messages: [
                new AIMessage({
                  content: "The weather is nice",
                  id: "3",
                }),
              ],
            },
          },
          { post_model_hook: { flag: true } },
          {
            generate_structured_response: {
              structuredResponse: { temperature: 75 },
            },
          },
        ]);
      });

      it("postModelHook + partial tool call application", async () => {
        const llm = new FakeToolCallingChatModel({
          responses: [
            new AIMessage({
              content: "result1",
              tool_calls: [
                { name: "search_api", id: "tool_a", args: { query: "foo" } },
                { name: "search_api", id: "tool_b", args: { query: "bar" } },
              ],
            }),
            new AIMessage("done"),
          ],
        });

        const agent = createReactAgent({
          llm,
          tools: [new SearchAPI()],
          version,
          postModelHook: (state) => {
            const lastMessage = state.messages.at(-1);
            if (
              lastMessage != null &&
              isAIMessage(lastMessage) &&
              lastMessage.tool_calls?.length
            ) {
              // apply only the first tool call
              const firstToolCall = lastMessage.tool_calls[0]!;

              return {
                messages: [
                  new ToolMessage({
                    content: "post-model-hook",
                    tool_call_id: firstToolCall.id!,
                  }),
                ],
              };
            }

            return {};
          },
        });

        const result = await agent.invoke({
          messages: [new HumanMessage("What's the weather?")],
        });

        expect(result).toMatchObject({
          messages: [
            { text: "What's the weather?" },
            {
              tool_calls: [
                { name: "search_api", id: "tool_a", args: { query: "foo" } },
                { name: "search_api", id: "tool_b", args: { query: "bar" } },
              ],
            },
            { text: "post-model-hook" },
            { text: "result for bar" },
            { text: "done" },
          ],
        });
      });

      it.each([
        [
          {
            name: "no tools",
            graph: createReactAgent({
              version,
              llm: new FakeToolCallingChatModel({}),
              tools: [],
            }),
            structure: [
              "__start__ --> agent",
              "agent -.-> __end__",
              "agent -.-> tools",
              "tools --> agent",
            ],
          },
        ],
        [
          {
            name: "tools",
            graph: createReactAgent({
              llm: new FakeToolCallingChatModel({}),
              version,
              tools: [
                tool(() => "The weather is sunny and 75°F.", {
                  name: "get_weather",
                  description: "Get the weather",
                  schema: z.object({}),
                }),
              ],
            }),
            structure: [
              "__start__ --> agent",
              "agent -.-> __end__",
              "agent -.-> tools",
              "tools --> agent",
            ],
          },
        ],

        [
          {
            name: "pre + tools",
            graph: createReactAgent({
              llm: new FakeToolCallingChatModel({}),
              version,
              tools: [
                tool(() => "The weather is sunny and 75°F.", {
                  name: "get_weather",
                  description: "Get the weather",
                  schema: z.object({}),
                }),
              ],
              preModelHook: () => ({ messages: [] }),
            }),
            structure: [
              "__start__ --> pre_model_hook",
              "agent -.-> __end__",
              "agent -.-> tools",
              "pre_model_hook --> agent",
              "tools --> pre_model_hook",
            ],
          },
        ],

        [
          {
            name: "tools + post",
            graph: createReactAgent({
              llm: new FakeToolCallingChatModel({}),
              version,
              tools: [
                tool(() => "The weather is sunny and 75°F.", {
                  name: "get_weather",
                  description: "Get the weather",
                  schema: z.object({}),
                }),
              ],
              postModelHook: () => ({ flag: true }),
              stateSchema: Annotation.Root({
                ...MessagesAnnotation.spec,
                flag: Annotation<boolean>,
              }),
            }),
            structure: [
              "__start__ --> agent",
              "agent --> post_model_hook",
              "tools --> agent",
              "post_model_hook -.-> tools",
              "post_model_hook -.-> agent",
              "post_model_hook -.-> __end__",
            ],
          },
        ],

        [
          {
            name: "tools + response format",
            graph: createReactAgent({
              llm: new FakeToolCallingChatModel({}),
              version,
              tools: [
                tool(() => "The weather is sunny and 75°F.", {
                  name: "get_weather",
                  description: "Get the weather",
                  schema: z.object({}),
                }),
              ],
              responseFormat: z.object({
                temperature: z
                  .number()
                  .describe("The temperature in fahrenheit"),
              }),
            }),
            structure: [
              "__start__ --> agent",
              "generate_structured_response --> __end__",
              "tools --> agent",
              "agent -.-> tools",
              "agent -.-> generate_structured_response",
            ],
          },
        ],

        [
          {
            name: "pre + tools + response format",
            graph: createReactAgent({
              llm: new FakeToolCallingChatModel({}),
              version,
              tools: [
                tool(() => "The weather is sunny and 75°F.", {
                  name: "get_weather",
                  description: "Get the weather",
                  schema: z.object({}),
                }),
              ],
              preModelHook: () => ({ messages: [] }),
              responseFormat: z.object({
                temperature: z
                  .number()
                  .describe("The temperature in fahrenheit"),
              }),
            }),
            structure: [
              "__start__ --> pre_model_hook",
              "pre_model_hook --> agent",
              "agent -.-> tools",
              "agent -.-> generate_structured_response",
              "generate_structured_response --> __end__",
              "tools --> pre_model_hook",
            ],
          },
        ],

        [
          {
            name: "tools + post + response format",
            graph: createReactAgent({
              llm: new FakeToolCallingChatModel({}),
              version,
              tools: [
                tool(() => "The weather is sunny and 75°F.", {
                  name: "get_weather",
                  description: "Get the weather",
                  schema: z.object({}),
                }),
              ],
              responseFormat: z.object({
                temperature: z
                  .number()
                  .describe("The temperature in fahrenheit"),
              }),
              postModelHook: () => ({ flag: true }),
              stateSchema: Annotation.Root({
                ...MessagesAnnotation.spec,
                flag: Annotation<boolean>,
              }),
            }),
            structure: [
              "__start__ --> agent",
              "agent --> post_model_hook",
              "generate_structured_response --> __end__",
              "tools --> agent",
              "post_model_hook -.-> tools",
              "post_model_hook -.-> agent",
              "post_model_hook -.-> generate_structured_response",
            ],
          },
        ],

        [
          {
            name: "pre + tools + post",
            graph: createReactAgent({
              llm: new FakeToolCallingChatModel({}),
              version,
              tools: [
                tool(() => "The weather is sunny and 75°F.", {
                  name: "get_weather",
                  description: "Get the weather",
                  schema: z.object({}),
                }),
              ],
              preModelHook: () => ({ messages: [] }),
              postModelHook: () => ({ flag: true }),
              stateSchema: Annotation.Root({
                ...MessagesAnnotation.spec,
                flag: Annotation<boolean>,
              }),
            }),
            structure: [
              "__start__ --> pre_model_hook",
              "pre_model_hook --> agent",
              "agent --> post_model_hook",
              "tools --> pre_model_hook",
              "post_model_hook -.-> tools",
              "post_model_hook -.-> pre_model_hook",
              "post_model_hook -.-> __end__",
            ],
          },
        ],

        [
          {
            name: "pre + tools + post + response format",
            graph: createReactAgent({
              llm: new FakeToolCallingChatModel({}),
              version,
              tools: [
                tool(() => "The weather is sunny and 75°F.", {
                  name: "get_weather",
                  description: "Get the weather",
                  schema: z.object({}),
                }),
              ],
              responseFormat: z.object({
                temperature: z
                  .number()
                  .describe("The temperature in fahrenheit"),
              }),
              preModelHook: () => ({ messages: [] }),
              postModelHook: () => ({ flag: true }),
              stateSchema: Annotation.Root({
                ...MessagesAnnotation.spec,
                flag: Annotation<boolean>,
              }),
            }),
            structure: [
              "__start__ --> pre_model_hook",
              "pre_model_hook --> agent",
              "agent --> post_model_hook",
              "generate_structured_response --> __end__",
              "tools --> pre_model_hook",
              "post_model_hook -.-> tools",
              "post_model_hook -.-> pre_model_hook",
              "post_model_hook -.-> generate_structured_response",
            ],
          },
        ],
      ])("mermaid $name", async ({ graph, structure }) => {
        expect(getReadableMermaid(await graph.getGraphAsync()).sort()).toEqual(
          structure.sort()
        );
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
          version,
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

        // Test with prompt and schema (and options)
        const agent2 = createReactAgent({
          llm,
          tools: [getWeather],
          version,
          responseFormat: {
            prompt: "Meow",
            schema: weatherResponseSchema,

            name: "generate_structured_response",
            strict: true,
          },
        });

        const withStructuredOutputSpy = vi.spyOn(llm, "withStructuredOutput");

        const result2 = await agent2.invoke({
          messages: [new HumanMessage("What's the weather?")],
        });

        // Check if `strict` is set properly
        expect(withStructuredOutputSpy).toHaveBeenCalledWith(
          weatherResponseSchema,
          { name: "generate_structured_response", strict: true }
        );

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

    describe("Dynamic Model", () => {
      it("should handle basic dynamic model functionality", async () => {
        const dynamicModel = (state: typeof MessagesAnnotation.State) => {
          // Return different models based on state
          if (state.messages.at(-1)?.text.includes("urgent")) {
            return new FakeToolCallingChatModel({
              responses: [new AIMessage("urgent called")],
            });
          }

          return new FakeToolCallingChatModel({ responses: [] });
        };

        const agent = createReactAgent({ llm: dynamicModel, tools: [] });

        const result = await agent.invoke({ messages: "hello" });
        expect(result.messages.at(-1)?.text).toBe("hello");

        const result2 = await agent.invoke({ messages: "urgent help" });
        expect(result2.messages.at(-1)?.text).toBe("urgent called");
      });

      it("should handle dynamic model with tool calling", async () => {
        const basicModel = new FakeToolCallingChatModel({
          responses: [
            new AIMessage({
              content: "",
              tool_calls: [{ args: { x: 1 }, id: "1", name: "basic_tool" }],
            }),
            new AIMessage("basic request"),
          ],
        });

        const basicTool = tool(
          async (args: { x: number }) => `basic: ${args.x}`,
          {
            name: "basic_tool",
            description: "Basic tool.",
            schema: z.object({ x: z.number() }),
          }
        );

        const advancedModel = new FakeToolCallingChatModel({
          responses: [
            new AIMessage({
              content: "",
              tool_calls: [{ args: { x: 1 }, id: "1", name: "advanced_tool" }],
            }),
            new AIMessage("advanced request"),
          ],
        });

        const advancedTool = tool(
          async (args: { x: number }) => `advanced: ${args.x}`,
          {
            name: "advanced_tool",
            description: "Advanced tool.",
            schema: z.object({ x: z.number() }),
          }
        );

        const dynamicModel = (state: typeof MessagesAnnotation.State) => {
          // Return model with different behaviors based on message content
          if (state.messages.at(-1)?.text.includes("advanced")) {
            return advancedModel;
          }

          return basicModel;
        };

        const agent = createReactAgent({
          llm: dynamicModel,
          tools: [basicTool, advancedTool],
          version,
        });

        // Test basic tool usage
        const result = await agent.invoke({ messages: "basic request" });
        expect(result.messages.slice(-2)).toMatchObject([
          { text: "basic: 1", name: "basic_tool" },
          { text: "basic request" },
        ]);

        // Test advanced tool usage
        const result2 = await agent.invoke({ messages: "advanced request" });
        expect(result2.messages.slice(-2)).toMatchObject([
          { text: "advanced: 1", name: "advanced_tool" },
          { text: "advanced request" },
        ]);
      });

      it("should handle dynamic model using config parameters", async () => {
        const context = z.object({ user_id: z.string() });

        const dynamicModel = (
          _: typeof MessagesAnnotation.State,
          runtime: Runtime<z.infer<typeof context>>
        ) => {
          // Use context to determine model behavior
          const user_id = runtime.context?.user_id;
          if (user_id === "user_premium") {
            return new FakeToolCallingChatModel({
              responses: [new AIMessage("premium")],
            });
          }

          return new FakeToolCallingChatModel({
            responses: [new AIMessage("basic")],
          });
        };

        const agent = createReactAgent({
          llm: dynamicModel,
          tools: [],
          version,
          contextSchema: context,
        });

        // Test with basic user
        expect(
          await agent.invoke(
            { messages: "hello" },
            { context: { user_id: "user_basic" } }
          )
        ).toMatchObject({
          messages: [{ text: "hello" }, { text: "basic" }],
        });

        // Test with premium user
        expect(
          await agent.invoke(
            { messages: "hello" },
            { context: { user_id: "user_premium" } }
          )
        ).toMatchObject({
          messages: [{ text: "hello" }, { text: "premium" }],
        });
      });

      it("should handle dynamic model with custom state schema", async () => {
        const CustomDynamicState = Annotation.Root({
          messages: MessagesAnnotation.spec.messages,
          model_preference: Annotation<"basic" | "advanced">({
            reducer: (_, next) => next,
            default: () => "basic",
          }),
        });

        const dynamicModel = (state: typeof CustomDynamicState.State) => {
          // Use custom state field to determine model
          if (state.model_preference === "advanced") {
            return new FakeToolCallingChatModel({
              responses: [new AIMessage("advanced")],
            });
          }

          return new FakeToolCallingChatModel({
            responses: [new AIMessage("basic")],
          });
        };

        const agent = createReactAgent({
          llm: dynamicModel,
          tools: [],
          version,
          stateSchema: CustomDynamicState,
        });

        expect(
          await agent.invoke({
            messages: [new HumanMessage("hello")],
            model_preference: "advanced",
          })
        ).toMatchObject({
          messages: [{ text: "hello" }, { text: "advanced" }],
        });
      });

      it("should handle dynamic model with different prompt types", async () => {
        const model = new FakeToolCallingChatModel({
          responses: [new AIMessage("ai response")],
        });
        const spyInvoke = vi.spyOn(model, "invoke");

        // Test with string prompt
        const agent = createReactAgent({
          llm: () => model,
          tools: [],
          version,
          prompt: "system_msg",
        });

        expect(await agent.invoke({ messages: "human_msg" })).toMatchObject({
          messages: [{ text: "human_msg" }, { text: "ai response" }],
        });

        expect(spyInvoke).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({ text: "system_msg" }),
            expect.objectContaining({ text: "human_msg" }),
          ]),
          expect.any(Object)
        );

        spyInvoke.mockClear();

        // Test with callable prompt
        const dynamicPrompt = (state: typeof MessagesAnnotation.State) => {
          return [new SystemMessage("system_msg"), ...state.messages];
        };

        const agent2 = createReactAgent({
          llm: () => model,
          tools: [],
          version,
          prompt: dynamicPrompt,
        });

        expect(await agent2.invoke({ messages: "human_msg" })).toMatchObject({
          messages: [{ text: "human_msg" }, { text: "ai response" }],
        });

        expect(spyInvoke).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({ text: "system_msg" }),
            expect.objectContaining({ text: "human_msg" }),
          ]),
          expect.any(Object)
        );
      });

      it("should handle dynamic model with structured response format", async () => {
        const TestResponse = z.object({
          message: z.string(),
          confidence: z.number(),
        });

        const dynamicModel = () => {
          const expectedResponse = {
            message: "dynamic response",
            confidence: 0.9,
          };

          return new FakeToolCallingChatModel({
            responses: [new AIMessage("dynamic response")],
            structuredResponse: expectedResponse,
          });
        };

        const agent = createReactAgent({
          llm: dynamicModel,
          tools: [],
          version,
          responseFormat: TestResponse,
        });

        expect(await agent.invoke({ messages: "hello" })).toMatchObject({
          messages: [{ text: "hello" }, { text: "dynamic response" }],
          structuredResponse: {
            message: "dynamic response",
            confidence: 0.9,
          },
        });
      });

      it("should handle dynamic model that changes available tools based on state", async () => {
        const toolA = tool(async (args: { x: number }) => `A: ${args.x}`, {
          name: "tool_a",
          description: "Tool A.",
          schema: z.object({ x: z.number() }),
        });

        const modelA = new FakeToolCallingChatModel({
          responses: [
            new AIMessage({
              content: "",
              tool_calls: [{ args: { x: 1 }, id: "1", name: "tool_a" }],
            }),
            new AIMessage({ content: "use_a please" }),
          ],
        });

        const toolB = tool(async (args: { x: number }) => `B: ${args.x}`, {
          name: "tool_b",
          description: "Tool B.",
          schema: z.object({ x: z.number() }),
        });

        const modelB = new FakeToolCallingChatModel({
          responses: [
            new AIMessage({
              content: "",
              tool_calls: [{ args: { x: 2 }, id: "1", name: "tool_b" }],
            }),
            new AIMessage({ content: "use_b please" }),
          ],
        });

        const dynamicModel = (state: typeof MessagesAnnotation.State) => {
          // Switch tools based on message history
          if (state.messages.some((msg) => msg.text.includes("use_b"))) {
            return modelB;
          }

          return modelA;
        };

        const agent = createReactAgent({
          llm: dynamicModel,
          version,
          tools: [toolA, toolB],
        });

        // Ask to use tool A
        expect(await agent.invoke({ messages: "use_a" })).toMatchObject({
          messages: [
            { text: "use_a" },
            { tool_calls: [{ args: { x: 1 }, name: "tool_a" }] },
            { text: "A: 1" },
            { text: "use_a please" },
          ],
        });

        // Ask to use tool B
        expect(await agent.invoke({ messages: "use_b" })).toMatchObject({
          messages: [
            { text: "use_b" },
            { tool_calls: [{ args: { x: 2 }, name: "tool_b" }] },
            { text: "B: 2" },
            { text: "use_b please" },
          ],
        });
      });

      it("should handle error handling in dynamic model", async () => {
        const failingDynamicModel = (
          state: typeof MessagesAnnotation.State
        ) => {
          if (state.messages.at(-1)?.text.includes("fail")) {
            throw new Error("Dynamic model failed");
          }

          return new FakeToolCallingChatModel({
            responses: [new AIMessage("ai response")],
          });
        };

        const agent = createReactAgent({
          llm: failingDynamicModel,
          version,
          tools: [],
        });

        // Normal operation should work
        expect(await agent.invoke({ messages: "hello" })).toMatchObject({
          messages: [{ text: "hello" }, { text: "ai response" }],
        });

        // Should propagate the error
        await expect(
          agent.invoke({ messages: [new HumanMessage("fail now")] })
        ).rejects.toThrow("Dynamic model failed");
      });

      it("should produce equivalent results when configured the same", async () => {
        // Static model
        const staticAgent = createReactAgent({
          llm: new FakeToolCallingChatModel({
            responses: [new AIMessage("ai response")],
          }),
          tools: [],
          version,
        });

        // Dynamic model returning the same model
        const dynamicAgent = createReactAgent({
          llm: () =>
            new FakeToolCallingChatModel({
              responses: [new AIMessage("ai response")],
            }),
          tools: [],
          version,
        });

        const inputMsg = { messages: "test message" };

        const staticResult = await staticAgent.invoke(inputMsg);
        const dynamicResult = await dynamicAgent.invoke(inputMsg);

        // Results should be equivalent (content-wise, IDs may differ)
        expect(staticResult.messages.length).toEqual(
          dynamicResult.messages.length
        );
        expect(staticResult.messages[0].text).toEqual(
          dynamicResult.messages[0].text
        );
        expect(staticResult.messages[1].text).toEqual(
          dynamicResult.messages[1].text
        );
      });

      it("should receive correct state, not the model input", async () => {
        const CustomAgentState = Annotation.Root({
          messages: MessagesAnnotation.spec.messages,
          custom_field: Annotation<string>,
        });

        const dynamicModel = vi.fn(
          () =>
            new FakeToolCallingChatModel({
              responses: [new AIMessage("ai response")],
            })
        );

        const agent = createReactAgent({
          llm: dynamicModel,
          tools: [],
          version,
          stateSchema: CustomAgentState,
        });

        // Test with initial state
        const inputState = {
          messages: [new HumanMessage("hello")],
          custom_field: "test_value",
        };
        await agent.invoke(inputState);

        // The dynamic model function should receive the original state, not the processed model input
        expect(dynamicModel).toHaveBeenCalledWith(
          inputState,
          expect.any(Object)
        );
      });
    });

    it.skipIf(version === "v1")("parallel tool calls", async () => {
      const humanAssistance = tool(
        async (args) => {
          const human = interrupt({ query: args.query }) as { data: string };
          return human.data;
        },
        {
          name: "human_assistance",
          description: "Human assistance",
          schema: z.object({ query: z.string() }),
        }
      );

      const weather = tool((args) => `It's sunny in ${args.location}`, {
        name: "weather",
        description: "Weather tool",
        schema: z.object({ location: z.string() }),
      });

      const checkpointer = new MemorySaverAssertImmutable();

      const toolCalls = [
        {
          args: { location: "sf" },
          name: "weather",
          id: "get_weather",
        },
        {
          args: { query: "help me" },
          name: "human_assistance",
          id: "get_help",
        },
      ];

      const agent = createReactAgent({
        llm: new FakeToolCallingChatModel({
          responses: [
            new AIMessage({ content: "ai response", tool_calls: toolCalls }),
            new AIMessage({ content: "final response" }),
          ],
        }),
        tools: [humanAssistance, weather],
        version,
        checkpointer,
      });

      const config = { configurable: { thread_id: "1" } };
      const stream = await gatherIterator(
        agent.stream(
          { messages: "Get user assistance and also check the weather" },
          { ...config, streamMode: "values" }
        )
      );

      expect(stream).toMatchObject([
        {
          messages: [
            { text: "Get user assistance and also check the weather" },
          ],
        },
        {
          messages: [
            { text: "Get user assistance and also check the weather" },
            { text: "ai response", tool_calls: toolCalls },
          ],
        },
        {
          __interrupt__: [
            { id: expect.any(String), value: { query: "help me" } },
          ],
        },
        {
          messages: [
            { text: "Get user assistance and also check the weather" },
            { text: "ai response", tool_calls: toolCalls },
            { text: "It's sunny in sf" },
          ],
        },
      ]);

      // resume
      const resume = await gatherIterator(
        agent.stream(new Command({ resume: { data: "Resumed!" } }), {
          ...config,
          streamMode: "values",
        })
      );

      expect(resume).toMatchObject([
        {
          messages: [
            { text: "Get user assistance and also check the weather" },
            { text: "ai response", tool_calls: toolCalls },
          ],
        },
        {
          messages: [
            { text: "Get user assistance and also check the weather" },
            { text: "ai response", tool_calls: toolCalls },
            { text: "It's sunny in sf" },
            { text: "Resumed!" },
          ],
        },
        {
          messages: [
            { text: "Get user assistance and also check the weather" },
            { text: "ai response", tool_calls: toolCalls },
            { text: "It's sunny in sf" },
            { text: "Resumed!" },
            { text: "final response" },
          ],
        },
      ]);
    });

    it("inherit task context", async () => {
      const parrot = tool(
        async (args) => {
          const { messages } = getCurrentTaskInput() as {
            messages: BaseMessage[];
          };

          return `[tool] ${args.prefix}: ${messages
            .map((i) => i.text)
            .join(", ")}`;
        },
        {
          name: "test_tool",
          description: "Test tool",
          schema: z.object({ prefix: z.string() }),
        }
      );

      const agent = createReactAgent({
        llm: new FakeToolCallingChatModel({
          responses: [
            new AIMessage({
              content: "ai",
              tool_calls: [
                { name: "test_tool", args: { prefix: "parrot" }, id: "testid" },
              ],
            }),
          ],
        }),
        tools: [parrot],
        version,
      });

      expect(await agent.invoke({ messages: "input" })).toMatchObject({
        messages: [
          { text: "input" },
          {
            text: "ai",
            tool_calls: [
              { name: "test_tool", args: { prefix: "parrot" }, id: "testid" },
            ],
          },
          { text: "[tool] parrot: input, ai" },
        ],
      });
    });

    it("should handle tool errors", async () => {
      const toolNode = new ToolNode([new SearchAPI()]);
      const res = await toolNode.invoke([
        new AIMessage({
          content: "",
          tool_calls: [{ name: "badtool", args: {}, id: "testid" }],
        }),
      ]);

      expect(res).toMatchObject([
        {
          status: "error",
          content:
            'Error: Tool "badtool" not found.\n Please fix your mistakes.',
        },
      ]);
    });
  }
);

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
      const lastMessage = messages[messages.length - 1];
      if (!isAIMessage(lastMessage)) return "__end__";

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

describe("MessagesZodState", () => {
  it("should assign ids properly and avoid duping added messages", async () => {
    const childGraph = new StateGraph(MessagesZodState)
      .addNode("duper", ({ messages }) => ({ messages }))
      .addNode("duper2", () => ({ messages: [new AIMessage("duper2")] }))
      .addEdge("__start__", "duper")
      .addEdge("duper", "duper2")
      .compile({ interruptBefore: ["duper2"] });

    const graph = new StateGraph(MessagesZodState)
      .addNode("duper", childGraph)
      .addNode("duper2", ({ messages }) => ({ messages }))
      .addEdge("__start__", "duper")
      .addEdge("duper", "duper2")
      .compile({ checkpointer: new MemorySaverAssertImmutable() });

    const res = await graph.invoke(
      { messages: [new HumanMessage("should be only one")] },
      { configurable: { thread_id: "1" } }
    );
    expect(res.messages.length).toEqual(1);

    const res2 = await graph.invoke(null, { configurable: { thread_id: "1" } });
    expect(res2.messages.length).toEqual(2);
  });

  it("should handle message reducers correctly", async () => {
    const graph = new StateGraph(MessagesZodState)
      .addNode("add", ({ messages }) => ({
        messages: [...messages, new HumanMessage("new message")],
      }))
      .addNode("remove", ({ messages }) => {
        return {
          messages: [new RemoveMessage({ id: messages[0].id ?? "" })],
        };
      })
      .addEdge("__start__", "add")
      .addEdge("add", "remove")
      .compile();

    const result = await graph.invoke({
      messages: [new HumanMessage({ id: "test-id", content: "original" })],
    });

    expect(result.messages.length).toEqual(1);
  });

  it("should handle array updates correctly", async () => {
    const graph = new StateGraph(MessagesZodState)
      .addNode("add", () => ({
        messages: [
          new HumanMessage({ id: "msg1", content: "message 1" }),
          new HumanMessage({ id: "msg2", content: "message 2" }),
        ],
      }))
      .addNode("update", ({ messages }) => {
        const firstMessageId = messages[0]?.id;
        if (!firstMessageId) {
          throw new Error("No message ID found");
        }
        return {
          messages: [
            new HumanMessage({ id: firstMessageId, content: "updated" }),
          ],
        };
      })
      .addEdge("__start__", "add")
      .addEdge("add", "update")
      .compile();

    const result = await graph.invoke({ messages: [] });

    expect(result.messages.length).toEqual(2);
    expect(result.messages[0].content).toEqual("updated");
    expect(result.messages[1].content).toEqual("message 2");
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
      expect(await _shouldBindTools(model, [])).toBe(true);
      expect(await _shouldBindTools(model, [tool1])).toBe(true);

      // Should bind when a seq
      const seq = RunnableSequence.from([
        model,
        RunnableLambda.from((message) => message),
      ]);
      expect(await _shouldBindTools(seq, [])).toBe(true);
      expect(await _shouldBindTools(seq, [tool1])).toBe(true);

      // Should not bind when a model with tools
      const modelWithTools = model.bindTools([tool1]);
      expect(await _shouldBindTools(modelWithTools, [tool1])).toBe(false);

      // Should not bind when a seq with tools
      const seqWithTools = RunnableSequence.from([
        model.bindTools([tool1]),
        RunnableLambda.from((message) => message),
      ]);
      expect(await _shouldBindTools(seqWithTools, [tool1])).toBe(false);

      // Should raise on invalid inputs
      await expect(
        async () => await _shouldBindTools(model.bindTools([tool1]), [])
      ).rejects.toThrow();
      await expect(
        async () => await _shouldBindTools(model.bindTools([tool1]), [tool2])
      ).rejects.toThrow();
      await expect(
        async () =>
          await _shouldBindTools(model.bindTools([tool1]), [tool1, tool2])
      ).rejects.toThrow();

      // test configurable model
      const configurableModel = new FakeConfigurableModel({
        model,
      });

      // Should bind when a regular model
      expect(await _shouldBindTools(configurableModel, [])).toBe(true);
      expect(await _shouldBindTools(configurableModel, [tool1])).toBe(true);

      // Should bind when a seq
      const configurableSeq = RunnableSequence.from([
        configurableModel,
        RunnableLambda.from((message) => message),
      ]);
      expect(await _shouldBindTools(configurableSeq, [])).toBe(true);
      expect(await _shouldBindTools(configurableSeq, [tool1])).toBe(true);

      // Should not bind when a model with tools
      const configurableModelWithTools = configurableModel.bindTools([tool1]);
      expect(await _shouldBindTools(configurableModelWithTools, [tool1])).toBe(
        false
      );

      // Should not bind when a seq with tools
      const configurableSeqWithTools = RunnableSequence.from([
        configurableModel.bindTools([tool1]),
        RunnableLambda.from((message) => message),
      ]);
      expect(await _shouldBindTools(configurableSeqWithTools, [tool1])).toBe(
        false
      );

      // Should raise on invalid inputs
      await expect(
        async () =>
          await _shouldBindTools(configurableModel.bindTools([tool1]), [])
      ).rejects.toThrow();
      await expect(
        async () =>
          await _shouldBindTools(configurableModel.bindTools([tool1]), [tool2])
      ).rejects.toThrow();
      await expect(
        async () =>
          await _shouldBindTools(configurableModel.bindTools([tool1]), [
            tool1,
            tool2,
          ])
      ).rejects.toThrow();
    }
  );

  it("should bind model with bindTools", async () => {
    const tool1 = tool((input) => `Tool 1: ${input.someVal}`, {
      name: "tool1",
      description: "Tool 1 docstring.",
      schema: z.object({
        someVal: z.number().describe("Input value"),
      }),
    });

    const model = new FakeToolCallingChatModel({
      responses: [new AIMessage("test")],
      toolStyle: "openai",
    });

    const confModel = new FakeConfigurableModel({ model });

    async function serialize(runnable: Runnable | Promise<Runnable>) {
      return JSON.parse(JSON.stringify(await runnable));
    }

    // Should bind when a regular model
    expect(await serialize(_bindTools(model, [tool1]))).toEqual(
      await serialize(model.bindTools([tool1]))
    );

    // Should bind when model wrapped in `withConfig`
    expect(
      await serialize(
        _bindTools(model.withConfig({ tags: ["nostream"] }), [tool1])
      )
    ).toEqual(
      await serialize(
        model.bindTools([tool1]).withConfig({ tags: ["nostream"] })
      )
    );

    // Should bind when model wrapped in multiple `withConfig`
    expect(
      await serialize(
        _bindTools(
          model
            .withConfig({ tags: ["nostream"] })
            .withConfig({ metadata: { hello: "world" } }),
          [tool1]
        )
      )
    ).toEqual(
      await serialize(
        model
          .bindTools([tool1])
          .withConfig({ tags: ["nostream"], metadata: { hello: "world" } })
      )
    );

    // Should bind when a configurable model
    expect(await serialize(_bindTools(confModel, [tool1]))).toEqual(
      await serialize(confModel.bindTools([tool1]))
    );

    // Should bind when a seq
    expect(
      await serialize(
        _bindTools(
          RunnableSequence.from([
            model,
            RunnableLambda.from((message) => message),
          ]),
          [tool1]
        )
      )
    ).toEqual(
      await serialize(
        RunnableSequence.from([
          model.bindTools([tool1]),
          RunnableLambda.from((message) => message),
        ])
      )
    );

    // Should bind when a seq with configurable model
    expect(
      await serialize(
        _bindTools(
          RunnableSequence.from([
            confModel,
            RunnableLambda.from((message) => message),
          ]),
          [tool1]
        )
      )
    ).toEqual(
      await serialize(
        RunnableSequence.from([
          confModel.bindTools([tool1]),
          RunnableLambda.from((message) => message),
        ])
      )
    );

    // Should bind when a seq with config model
    expect(
      await serialize(
        _bindTools(
          RunnableSequence.from([
            confModel.withConfig({ tags: ["nostream"] }),
            RunnableLambda.from((message) => message),
          ]),
          [tool1]
        )
      )
    ).toEqual(
      await serialize(
        RunnableSequence.from([
          confModel.bindTools([tool1]).withConfig({
            tags: ["nostream"],
          }),
          RunnableLambda.from((message) => message),
        ])
      )
    );
  });

  it("should handle bindTool with server tools", async () => {
    const tool1 = tool((input) => `Tool 1: ${input.someVal}`, {
      name: "tool1",
      description: "Tool 1 docstring.",
      schema: z.object({ someVal: z.number().describe("Input value") }),
    });

    const server = { type: "web_search_preview" };

    const model = new FakeToolCallingChatModel({
      responses: [new AIMessage("test")],
    });

    expect(await _shouldBindTools(model, [tool1, server])).toBe(true);
    expect(
      await _shouldBindTools(model.bindTools([tool1, server]), [tool1, server])
    ).toBe(false);

    await expect(
      _shouldBindTools(model.bindTools([tool1]), [tool1, server])
    ).rejects.toThrow();

    await expect(
      _shouldBindTools(model.bindTools([server]), [tool1, server])
    ).rejects.toThrow();
  });
});

describe("_getModel", () => {
  it("Should extract the model from different inputs", async () => {
    const model = new FakeToolCallingChatModel({
      responses: [new AIMessage("test")],
    });
    expect(await _getModel(model)).toBe(model);

    const tool1 = tool((input) => `Tool 1: ${input.someVal}`, {
      name: "tool1",
      description: "Tool 1 docstring.",
      schema: z.object({
        someVal: z.number().describe("Input value"),
      }),
    });

    const modelWithTools = model.bindTools([tool1]);
    expect(await _getModel(modelWithTools)).toBe(model);

    const seq = RunnableSequence.from([
      model,
      RunnableLambda.from((message) => message),
    ]);
    expect(await _getModel(seq)).toBe(model);

    const seqWithTools = RunnableSequence.from([
      model.bindTools([tool1]),
      RunnableLambda.from((message) => message),
    ]);
    expect(await _getModel(seqWithTools)).toBe(model);

    const raisingSeq = RunnableSequence.from([
      RunnableLambda.from((message) => message),
      RunnableLambda.from((message) => message),
    ]);
    await expect(async () => await _getModel(raisingSeq)).rejects.toThrow(
      Error
    );

    // test configurable model
    const configurableModel = new FakeConfigurableModel({
      model,
    });

    expect(await _getModel(configurableModel)).toBe(model);
    expect(await _getModel(configurableModel.bindTools([tool1]))).toBe(model);

    const configurableSeq = RunnableSequence.from([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      configurableModel as any,
      RunnableLambda.from((message) => message),
    ]);
    expect(await _getModel(configurableSeq)).toBe(model);

    const configurableSeqWithTools = RunnableSequence.from([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      configurableModel.bindTools([tool1]) as any,
      RunnableLambda.from((message) => message),
    ]);
    expect(await _getModel(configurableSeqWithTools)).toBe(model);

    const raisingConfigurableSeq = RunnableSequence.from([
      RunnableLambda.from((message) => message),
      RunnableLambda.from((message) => message),
    ]);
    await expect(
      async () => await _getModel(raisingConfigurableSeq)
    ).rejects.toThrow(Error);
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

    expect(result).toMatchObject([
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

    expect(singleToolResult).toMatchObject([
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

    expect(asyncToolResult).toMatchObject([
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

    expect(multipleCommandsResult).toMatchObject([
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

    expect(result).toMatchObject([
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

      expect(result).toMatchObject([
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

    expect(multipleCommandsResult).toMatchObject([
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

    expect(result).toMatchObject([
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
