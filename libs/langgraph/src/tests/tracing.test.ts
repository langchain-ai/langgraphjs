import { expect, it } from "@jest/globals";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import { FakeToolCallingChatModel } from "./utils.js";
// Import from main `@langchain/langgraph` endpoint to turn on automatic config passing
import { END, START, StateGraph } from "../index.js";
import { gatherIterator } from "../utils.js";

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
