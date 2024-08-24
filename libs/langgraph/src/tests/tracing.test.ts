import { expect, it } from "@jest/globals";
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { FakeToolCallingChatModel } from "./utils.js";
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
        langgraph_task_idx: 0,
        langgraph_triggers: ["__start__"],
      }),
    },
    {
      event: "on_chain_end",
      data: {
        output: { output: undefined },
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
        langgraph_task_idx: 0,
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
        langgraph_task_idx: 0,
        langgraph_triggers: ["start:testnode"],
      }),
    },
    {
      event: "on_chain_start",
      data: {
        input: {
          messages: [],
        },
      },
      name: "RunnableLambda",
      tags: ["seq:step:1"],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_task_idx: 0,
        langgraph_triggers: ["start:testnode"],
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
        langgraph_task_idx: 0,
        langgraph_triggers: ["start:testnode"],
        ls_model_type: "chat",
        ls_stop: undefined,
      }),
    },
    {
      event: "on_chat_model_stream",
      data: {
        chunk: new AIMessageChunk("hey!"),
      },
      name: "model_call",
      tags: [],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_task_idx: 0,
        langgraph_triggers: ["start:testnode"],
        ls_model_type: "chat",
        ls_stop: undefined,
      }),
    },
    {
      event: "on_chat_model_end",
      data: {
        output: new AIMessage("hey!"),
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
        langgraph_task_idx: 0,
        langgraph_triggers: ["start:testnode"],
        ls_model_type: "chat",
        ls_stop: undefined,
      }),
    },
    {
      event: "on_chain_end",
      data: {
        output: {
          messages: [new AIMessage("hey!")],
        },
        input: {
          messages: [],
        },
      },
      run_id: expect.any(String),
      name: "RunnableLambda",
      tags: ["seq:step:1"],
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_task_idx: 0,
        langgraph_triggers: ["start:testnode"],
      }),
    },
    {
      event: "on_chain_start",
      data: {
        input: {
          messages: [new AIMessage("hey!")],
        },
      },
      name: "ChannelWrite<messages,testnode>",
      tags: ["seq:step:2", "langsmith:hidden"],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_task_idx: 0,
        langgraph_triggers: ["start:testnode"],
      }),
    },
    {
      event: "on_chain_end",
      data: {
        output: { output: undefined },
        input: {
          messages: [new AIMessage("hey!")],
        },
      },
      run_id: expect.any(String),
      name: "ChannelWrite<messages,testnode>",
      tags: ["seq:step:2", "langsmith:hidden"],
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_task_idx: 0,
        langgraph_triggers: ["start:testnode"],
      }),
    },
    {
      event: "on_chain_start",
      data: {
        input: {
          input: undefined,
        },
      },
      name: "func",
      tags: ["seq:step:3"],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_task_idx: 0,
        langgraph_triggers: ["start:testnode"],
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
        langgraph_task_idx: 0,
        langgraph_triggers: ["start:testnode"],
        ls_model_type: "chat",
        ls_stop: undefined,
      }),
    },
    {
      event: "on_chat_model_stream",
      data: {
        chunk: new AIMessageChunk("hey!"),
      },
      name: "conditional_edge_call",
      tags: [],
      run_id: expect.any(String),
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_task_idx: 0,
        langgraph_triggers: ["start:testnode"],
        ls_model_type: "chat",
        ls_stop: undefined,
      }),
    },
    {
      event: "on_chat_model_end",
      data: {
        output: new AIMessage("hey!"),
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
        langgraph_task_idx: 0,
        langgraph_triggers: ["start:testnode"],
        ls_model_type: "chat",
        ls_stop: undefined,
      }),
    },
    {
      event: "on_chain_end",
      data: {
        output: {
          output: undefined,
        },
        input: {
          input: undefined,
        },
      },
      run_id: expect.any(String),
      name: "func",
      tags: ["seq:step:3"],
      metadata: expect.objectContaining({
        langgraph_node: "testnode",
        langgraph_step: 1,
        langgraph_task_idx: 0,
        langgraph_triggers: ["start:testnode"],
      }),
    },
    {
      event: "on_chain_end",
      data: {
        output: { output: undefined },
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
        langgraph_task_idx: 0,
        langgraph_triggers: ["start:testnode"],
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
            messages: [new AIMessage("hey!")],
          },
        },
      },
    },
    {
      event: "on_chain_end",
      data: {
        output: {
          messages: [new AIMessage("hey!")],
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

      const modelWithConfig = model.withConfig({
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
