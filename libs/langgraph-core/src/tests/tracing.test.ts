import { expect, it } from "vitest";
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import { _AnyIdAIMessage, _AnyIdAIMessageChunk } from "./utils.js";
import { FakeToolCallingChatModel } from "./utils.models.js";
// Import from main `@langchain/langgraph` endpoint to turn on automatic config passing
import { END, START, StateGraph } from "../index.js";
import { gatherIterator } from "../utils.js";
import { createReactAgent } from "../prebuilt/react_agent_executor.js";

it("stream events for a multi-node graph", async () => {
  const stateGraph = new StateGraph<{
    messages: BaseMessage[];
  }>({
    channels: { messages: null },
  });
  const graph = stateGraph
    .addNode("testnode", async (_) => {
      const model = new FakeToolCallingChatModel({
        responses: [new AIMessage("hey!")],
      }).withConfig({ runName: "model_call" });
      // Don't explicitly pass config here
      const res = await model.invoke("hello!");
      return { messages: [res] };
    })
    .addEdge(START, "testnode")
    .addConditionalEdges("testnode", async (_state) => {
      const model = new FakeToolCallingChatModel({
        responses: [new AIMessage("hey!")],
      }).withConfig({ runName: "conditional_edge_call" });
      await model.invoke("testing but should be traced");
      return END;
    })
    .compile();

  const eventStream = graph.streamEvents({ messages: [] }, { version: "v2" });
  const events = await gatherIterator(eventStream);
  expect(events).toEqual([
    {
      event: "on_chain_start",
      data: {
        input: {
          messages: [],
        },
      },
      name: "LangGraph",
      tags: [],
      run_id: expect.any(String),
      metadata: {},
    },
    {
      event: "on_chain_start",
      data: {
        input: {
          messages: [],
        },
      },
      name: "__start__",
      tags: ["graph:step:0", "langsmith:hidden"],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "__start__",
        langgraph_step: 0,
        langgraph_triggers: ["__start__"],
      }),
    },
    {
      event: "on_chain_start",
      data: { input: { messages: [] } },
      name: "ChannelWrite<...>",
      tags: ["langsmith:hidden"],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "__start__",
        langgraph_step: 0,
        langgraph_triggers: ["__start__"],
      }),
    },
    {
      event: "on_chain_end",
      data: { output: { messages: [] }, input: { messages: [] } },
      run_id: expect.any(String),
      name: "ChannelWrite<...>",
      tags: ["langsmith:hidden"],
      metadata: expect.objectContaining({
        langgraph_node: "__start__",
        langgraph_step: 0,
        langgraph_triggers: ["__start__"],
      }),
    },
    {
      event: "on_chain_start",
      data: { input: { messages: [] } },
      name: "ChannelWrite<branch:to:testnode>",
      tags: ["langsmith:hidden"],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "__start__",
        langgraph_step: 0,
        langgraph_triggers: ["__start__"],
      }),
    },
    {
      event: "on_chain_end",
      data: { output: { messages: [] }, input: { messages: [] } },
      run_id: expect.any(String),
      name: "ChannelWrite<branch:to:testnode>",
      tags: ["langsmith:hidden"],
      metadata: expect.objectContaining({
        langgraph_node: "__start__",
        langgraph_step: 0,
        langgraph_triggers: ["__start__"],
      }),
    },
    {
      event: "on_chain_end",
      data: {
        output: { messages: [] },
        input: {
          messages: [],
        },
      },
      run_id: expect.any(String),
      name: "__start__",
      tags: ["graph:step:0", "langsmith:hidden"],
      metadata: expect.objectContaining({
        langgraph_node: "__start__",
        langgraph_step: 0,
        langgraph_triggers: ["__start__"],
      }),
    },
    {
      event: "on_chain_start",
      data: {
        input: {
          messages: [],
        },
      },
      name: "testnode",
      tags: ["graph:step:1"],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
      }),
    },
    {
      event: "on_chat_model_start",
      data: {
        input: {
          messages: [[new HumanMessage("hello!")]],
        },
      },
      name: "model_call",
      tags: [],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
        ls_model_type: "chat",
        ls_stop: undefined,
      }),
    },
    {
      event: "on_chat_model_stream",
      data: {
        chunk: new _AnyIdAIMessageChunk("hey!"),
      },
      name: "model_call",
      tags: [],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
        ls_model_type: "chat",
        ls_stop: undefined,
      }),
    },
    {
      event: "on_chat_model_end",
      data: {
        output: new _AnyIdAIMessage("hey!"),
        input: {
          messages: [[new HumanMessage("hello!")]],
        },
      },
      run_id: expect.any(String),
      name: "model_call",
      tags: [],
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
        ls_model_type: "chat",
        ls_stop: undefined,
      }),
    },
    {
      event: "on_chain_start",
      data: {
        input: {
          messages: [new _AnyIdAIMessage("hey!")],
        },
      },
      name: "ChannelWrite<...>",
      tags: ["langsmith:hidden"],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
      }),
    },
    {
      event: "on_chain_end",
      data: {
        output: { messages: [new _AnyIdAIMessage("hey!")] },
        input: {
          messages: [new _AnyIdAIMessage("hey!")],
        },
      },
      run_id: expect.any(String),
      name: "ChannelWrite<...>",
      tags: ["langsmith:hidden"],
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
      }),
    },
    {
      event: "on_chain_start",
      data: {
        input: {
          messages: [new _AnyIdAIMessage("hey!")],
        },
      },
      run_id: expect.any(String),
      name: "Branch<testnode>",
      tags: [],
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
      }),
    },
    {
      event: "on_chat_model_start",
      data: {
        input: {
          messages: [[new HumanMessage("testing but should be traced")]],
        },
      },
      name: "conditional_edge_call",
      tags: [],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
        ls_model_type: "chat",
        ls_stop: undefined,
      }),
    },
    {
      event: "on_chat_model_stream",
      data: {
        chunk: new _AnyIdAIMessageChunk("hey!"),
      },
      name: "conditional_edge_call",
      tags: [],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
        ls_model_type: "chat",
        ls_stop: undefined,
      }),
    },
    {
      event: "on_chat_model_end",
      data: {
        output: new _AnyIdAIMessage("hey!"),
        input: {
          messages: [[new HumanMessage("testing but should be traced")]],
        },
      },
      run_id: expect.any(String),
      name: "conditional_edge_call",
      tags: [],
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
        ls_model_type: "chat",
        ls_stop: undefined,
      }),
    },
    {
      event: "on_chain_end",
      data: {
        input: {
          messages: [new _AnyIdAIMessage("hey!")],
        },
        output: "__end__",
      },
      run_id: expect.any(String),
      name: "Branch<testnode>",
      tags: [],
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
      }),
    },
    {
      event: "on_chain_end",
      data: {
        output: { messages: [new _AnyIdAIMessage("hey!")] },
        input: {
          messages: [],
        },
      },
      run_id: expect.any(String),
      name: "testnode",
      tags: ["graph:step:1"],
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
      }),
    },
    {
      event: "on_chain_stream",
      run_id: expect.any(String),
      name: "LangGraph",
      tags: [],
      metadata: {},
      data: {
        chunk: {
          testnode: {
            messages: [new _AnyIdAIMessage("hey!")],
          },
        },
      },
    },
    {
      event: "on_chain_end",
      data: {
        output: {
          messages: [new _AnyIdAIMessage("hey!")],
        },
      },
      run_id: expect.any(String),
      name: "LangGraph",
      tags: [],
      metadata: {},
    },
  ]);
});

it("stream events with a tool with a custom tag", async () => {
  const model = new FakeToolCallingChatModel({
    responses: [
      new AIMessage({
        tool_calls: [
          {
            id: "test_id",
            args: {
              place: "somewhere ",
            },
            name: "get_items",
            type: "tool_call",
          },
        ],
        content: "",
      }),
      new AIMessage("foo"),
    ],
  });
  const getItems = tool(
    async (input, config) => {
      const template = ChatPromptTemplate.fromMessages([
        [
          "human",
          "Can you tell me what kind of items i might find in the following place: '{place}'. " +
            "List at least 3 such items separating them by a comma. And include a brief description of each item..",
        ],
      ]);

      const modelWithConfig = new FakeToolCallingChatModel({
        responses: [new AIMessage("foo")],
      }).withConfig({
        runName: "Get Items LLM",
        tags: ["tool_llm"],
      });

      const chain = template.pipe(modelWithConfig);
      const result = await chain.invoke(input, config);
      return result.content;
    },
    {
      name: "get_items",
      description:
        "Use this tool to look up which items are in the given place.",
      schema: z.object({
        place: z.string(),
      }),
    }
  );
  const agent = createReactAgent({
    llm: model,
    tools: [getItems],
  });
  const chunks = await gatherIterator(
    agent.streamEvents(
      {
        messages: [["human", "what items are on the shelf?"]],
      },
      {
        version: "v2",
      },
      {
        includeTags: ["tool_llm"],
      }
    )
  );
  expect(chunks.length).toEqual(3);
});

it("Should respect .withConfig", async () => {
  const stateGraph = new StateGraph<{
    messages: BaseMessage[];
  }>({
    channels: { messages: null },
  });
  const graph = stateGraph
    .addNode("testnode", async (_) => {
      const model = new FakeToolCallingChatModel({
        responses: [new AIMessage("hey!")],
      }).withConfig({ runName: "model_call" });
      // Don't explicitly pass config here
      const res = await model.invoke("hello!");
      return { messages: [res] };
    })
    .addEdge(START, "testnode")
    .addConditionalEdges("testnode", async (_state) => {
      const model = new FakeToolCallingChatModel({
        responses: [new AIMessage("hey!")],
      }).withConfig({ runName: "conditional_edge_call" });
      await model.invoke("testing but should be traced");
      return END;
    })
    .compile()
    .withConfig({ runName: "OVERRIDDEN_NAME" });
  const eventStream = graph.streamEvents({ messages: [] }, { version: "v2" });
  const events = await gatherIterator(eventStream);
  expect(events).toEqual([
    {
      event: "on_chain_start",
      data: {
        input: {
          messages: [],
        },
      },
      name: "OVERRIDDEN_NAME",
      tags: [],
      run_id: expect.any(String),
      metadata: {},
    },
    {
      event: "on_chain_start",
      data: {
        input: {
          messages: [],
        },
      },
      name: "__start__",
      tags: ["graph:step:0", "langsmith:hidden"],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "__start__",
        langgraph_step: 0,
        langgraph_triggers: ["__start__"],
      }),
    },
    {
      event: "on_chain_start",
      data: { input: { messages: [] } },
      name: "ChannelWrite<...>",
      tags: ["langsmith:hidden"],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "__start__",
        langgraph_step: 0,
        langgraph_triggers: ["__start__"],
      }),
    },
    {
      event: "on_chain_end",
      data: { output: { messages: [] }, input: { messages: [] } },
      run_id: expect.any(String),
      name: "ChannelWrite<...>",
      tags: ["langsmith:hidden"],
      metadata: expect.objectContaining({
        langgraph_node: "__start__",
        langgraph_step: 0,
        langgraph_triggers: ["__start__"],
      }),
    },
    {
      event: "on_chain_start",
      data: { input: { messages: [] } },
      name: "ChannelWrite<branch:to:testnode>",
      tags: ["langsmith:hidden"],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "__start__",
        langgraph_step: 0,
        langgraph_triggers: ["__start__"],
      }),
    },
    {
      event: "on_chain_end",
      data: { output: { messages: [] }, input: { messages: [] } },
      run_id: expect.any(String),
      name: "ChannelWrite<branch:to:testnode>",
      tags: ["langsmith:hidden"],
      metadata: expect.objectContaining({
        langgraph_node: "__start__",
        langgraph_step: 0,
        langgraph_triggers: ["__start__"],
      }),
    },
    {
      event: "on_chain_end",
      data: {
        output: { messages: [] },
        input: {
          messages: [],
        },
      },
      run_id: expect.any(String),
      name: "__start__",
      tags: ["graph:step:0", "langsmith:hidden"],
      metadata: expect.objectContaining({
        langgraph_node: "__start__",
        langgraph_step: 0,
        langgraph_triggers: ["__start__"],
      }),
    },
    {
      event: "on_chain_start",
      data: {
        input: {
          messages: [],
        },
      },
      name: "testnode",
      tags: ["graph:step:1"],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
      }),
    },
    {
      event: "on_chat_model_start",
      data: {
        input: {
          messages: [[new HumanMessage("hello!")]],
        },
      },
      name: "model_call",
      tags: [],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
        ls_model_type: "chat",
        ls_stop: undefined,
      }),
    },
    {
      event: "on_chat_model_stream",
      data: {
        chunk: new _AnyIdAIMessageChunk("hey!"),
      },
      name: "model_call",
      tags: [],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
        ls_model_type: "chat",
        ls_stop: undefined,
      }),
    },
    {
      event: "on_chat_model_end",
      data: {
        output: new _AnyIdAIMessage("hey!"),
        input: {
          messages: [[new HumanMessage("hello!")]],
        },
      },
      run_id: expect.any(String),
      name: "model_call",
      tags: [],
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
        ls_model_type: "chat",
        ls_stop: undefined,
      }),
    },
    {
      event: "on_chain_start",
      data: {
        input: {
          messages: [new _AnyIdAIMessage("hey!")],
        },
      },
      name: "ChannelWrite<...>",
      tags: ["langsmith:hidden"],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
      }),
    },
    {
      event: "on_chain_end",
      data: {
        output: { messages: [new _AnyIdAIMessage("hey!")] },
        input: {
          messages: [new _AnyIdAIMessage("hey!")],
        },
      },
      run_id: expect.any(String),
      name: "ChannelWrite<...>",
      tags: ["langsmith:hidden"],
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
      }),
    },
    {
      event: "on_chain_start",
      data: {
        input: {
          messages: [new _AnyIdAIMessage("hey!")],
        },
      },
      run_id: expect.any(String),
      name: "Branch<testnode>",
      tags: [],
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
      }),
    },
    {
      event: "on_chat_model_start",
      data: {
        input: {
          messages: [[new HumanMessage("testing but should be traced")]],
        },
      },
      name: "conditional_edge_call",
      tags: [],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
        ls_model_type: "chat",
        ls_stop: undefined,
      }),
    },
    {
      event: "on_chat_model_stream",
      data: {
        chunk: new _AnyIdAIMessageChunk("hey!"),
      },
      name: "conditional_edge_call",
      tags: [],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
        ls_model_type: "chat",
        ls_stop: undefined,
      }),
    },
    {
      event: "on_chat_model_end",
      data: {
        output: new _AnyIdAIMessage("hey!"),
        input: {
          messages: [[new HumanMessage("testing but should be traced")]],
        },
      },
      run_id: expect.any(String),
      name: "conditional_edge_call",
      tags: [],
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
        ls_model_type: "chat",
        ls_stop: undefined,
      }),
    },
    {
      event: "on_chain_end",
      data: {
        input: {
          messages: [new _AnyIdAIMessage("hey!")],
        },
        output: "__end__",
      },
      run_id: expect.any(String),
      name: "Branch<testnode>",
      tags: [],
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
      }),
    },
    {
      event: "on_chain_end",
      data: {
        input: {
          messages: [],
        },
        output: { messages: [new _AnyIdAIMessage("hey!")] },
      },
      run_id: expect.any(String),
      name: "testnode",
      tags: ["graph:step:1"],
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_triggers: ["branch:to:testnode"],
      }),
    },
    {
      event: "on_chain_stream",
      run_id: expect.any(String),
      name: "OVERRIDDEN_NAME",
      tags: [],
      metadata: {},
      data: {
        chunk: {
          testnode: {
            messages: [new _AnyIdAIMessage("hey!")],
          },
        },
      },
    },
    {
      event: "on_chain_end",
      data: {
        output: {
          messages: [new _AnyIdAIMessage("hey!")],
        },
      },
      run_id: expect.any(String),
      name: "OVERRIDDEN_NAME",
      tags: [],
      metadata: {},
    },
  ]);
});
