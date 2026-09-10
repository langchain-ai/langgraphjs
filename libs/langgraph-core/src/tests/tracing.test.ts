import { expect, it } from "vitest";
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import { _AnyIdAIMessage, _AnyIdAIMessageChunk } from "./utils.js";
import { FakeChatModel, FakeToolCallingChatModel } from "./utils.models.js";
// Import from main `@langchain/langgraph` endpoint to turn on automatic config passing
import { Annotation, END, START, StateGraph } from "../web.js";
import { MessagesAnnotation } from "../graph/messages_annotation.js";
import { gatherIterator } from "../utils.js";
import { createReactAgent } from "../prebuilt/react_agent_executor.js";

type CapturedTrace = {
  name: string;
  metadata: Record<string, unknown>;
};

const TraceState = Annotation.Root({
  value: Annotation<string>,
});

function createOfflineTracer(): {
  tracer: LangChainTracer;
  traces: CapturedTrace[];
} {
  const traces: CapturedTrace[] = [];
  const client = {
    createRun: async (run: {
      name?: string;
      extra?: { metadata?: Record<string, unknown> };
    }) => {
      traces.push({
        name: run.name ?? "",
        metadata: run.extra?.metadata ?? {},
      });
    },
    updateRun: async () => {},
    batchIngestRuns: async () => {},
  } as unknown as LangChainTracer["client"];
  return {
    tracer: new LangChainTracer({ client, projectName: "tracing-test" }),
    traces,
  };
}

it("omits context aliases from every LangSmith trace", async () => {
  const { tracer, traces } = createOfflineTracer();
  const sentinel = "context-sentinel";
  const graph = new StateGraph(TraceState)
    .addNode("node", (_state, config) => {
      expect(config.context?.mirrored).toBe(sentinel);
      expect(config.configurable?.mirrored).toBe(sentinel);
      return { value: "done" };
    })
    .addEdge(START, "node")
    .addEdge("node", END)
    .compile();

  await graph.invoke(
    { value: "start" },
    {
      callbacks: [tracer],
      context: {
        mirrored: sentinel,
        unequal: "context-value",
      },
      configurable: {
        mirrored: sentinel,
        unequal: "configurable-value",
        tenantId: "keep-me",
        thread_id: "thread-1",
        run_id: "run-1",
        assistant_id: "assistant-1",
        graph_id: "graph-1",
      },
      metadata: { explicit: "metadata-value" },
    }
  );

  expect(traces.map(({ name }) => name)).toEqual([
    "LangGraph",
    "__start__",
    "node",
  ]);
  for (const { metadata } of traces) {
    expect(metadata.mirrored).toBeUndefined();
    expect(metadata.unequal).toBe("configurable-value");
    expect(metadata.tenantId).toBe("keep-me");
    expect(metadata.explicit).toBe("metadata-value");
    expect(metadata.thread_id).toBe("thread-1");
    expect(metadata.run_id).toBe("run-1");
    expect(metadata.assistant_id).toBe("assistant-1");
    expect(metadata.graph_id).toBe("graph-1");
  }
});

it("keeps configurable-only values in every LangSmith trace", async () => {
  const { tracer, traces } = createOfflineTracer();
  const graph = new StateGraph(TraceState)
    .addNode("node", (_state, config) => {
      expect(config.context).toBeUndefined();
      expect(config.configurable?.legacy).toBe("configurable-value");
      return { value: "done" };
    })
    .addEdge(START, "node")
    .addEdge("node", END)
    .compile();

  await graph.invoke(
    { value: "start" },
    {
      callbacks: [tracer],
      configurable: {
        legacy: "configurable-value",
      },
    }
  );

  expect(traces).toHaveLength(3);
  for (const { metadata } of traces) {
    expect(metadata.legacy).toBe("configurable-value");
  }
});

it("merges graph-bound callbacks with invoke-time callbacks in streamEvents (no double-firing)", async () => {
  class CountingHandler extends BaseCallbackHandler {
    name: string;

    chainStarts = 0;

    constructor(name: string) {
      super();
      this.name = name;
    }

    handleChainStart() {
      this.chainStarts += 1;
    }
  }

  const boundCb = new CountingHandler("bound_handler");
  const userCb = new CountingHandler("user_handler");

  const graph = new StateGraph<{ messages: BaseMessage[] }>({
    channels: { messages: null },
  })
    .addNode("testnode", async () => ({ messages: [new AIMessage("hi")] }))
    .addEdge(START, "testnode")
    .addEdge("testnode", END)
    .compile();

  // Bind a callback on the graph itself (as `.withConfig({ callbacks })`
  // does), then supply a different callback at call time.
  const boundGraph = graph.withConfig({ callbacks: [boundCb] });

  await gatherIterator(
    boundGraph.streamEvents(
      { messages: [] },
      { version: "v2", callbacks: [userCb] }
    )
  );

  // Both handlers should be registered exactly once, so each sees the same
  // set of runs. Before the `ensureLangGraphConfig` merge fix, the
  // graph-bound handler was injected twice (once by the `streamEvents`
  // `combineCallbacks` workaround and again by the config merge), firing
  // for every run twice.
  expect(boundCb.chainStarts).toBeGreaterThan(0);
  expect(userCb.chainStarts).toBeGreaterThan(0);
  expect(boundCb.chainStarts).toBe(userCb.chainStarts);
});


it("does not double stream tokens from a nested graph under tracing", async () => {
  // Regression for double-streaming: tracing installs the real
  // AsyncLocalStorage config, so a nested Pregel entry merges an ambient
  // config against an explicit config that already carries the same
  // StreamMessagesHandler. Before the `mergeCallbacks` dedupe fix,
  // concatenating registered it twice and `streamMode: "messages"`
  // delivered every token twice.
  const ANSWER = "Hello world from langgraph";

  const buildInnerGraph = () => {
    const model = new FakeChatModel({
      responses: [new AIMessage(`${ANSWER} `)],
    }).withConfig({ runName: "model_call" });
    return new StateGraph(MessagesAnnotation)
      .addNode("agent", async () => {
        // Stream so handleLLMNewToken fires per token.
        const chunks = await model.stream("say hello");
        const parts: string[] = [];
        for await (const chunk of chunks) {
          if (typeof chunk.content === "string") parts.push(chunk.content);
        }
        return { messages: [new AIMessage(parts.join(""))] };
      })
      .addEdge(START, "agent")
      .addEdge("agent", END)
      .compile({ name: "Inner" });
  };

  const streamAndCollect = async (
    graph: ReturnType<typeof buildInnerGraph>
  ) => {
    let text = "";
    for await (const [, mode, data] of await graph.stream(
      { messages: [{ role: "user", content: "say hello" }] },
      { streamMode: ["messages", "updates"], subgraphs: true }
    )) {
      if (mode !== "messages") continue;
      const [message] = data;
      if (
        message?.getType?.() === "ai" &&
        typeof message.content === "string"
      ) {
        text += message.content;
      }
    }
    return text;
  };

  // Turn tracing on so the real AsyncLocalStorage config is installed and
  // the ambient/explicit config merge path is exercised. Override the
  // fetch implementation langsmith uses (via its well-known symbol key) so
  // core's auto-built LangChainTracer can't reach the network.
  process.env.LANGSMITH_TRACING = "true";
  const fetchKey = Symbol.for("ls:fetch_implementation");
  const noopFetch = async () => new Response("{}", { status: 200 });
  (globalThis as Record<symbol, unknown>)[fetchKey] = noopFetch;
  try {
    let innerText = "";
    const outer = new StateGraph(MessagesAnnotation)
      .addNode("delegate", async () => {
        innerText = await streamAndCollect(buildInnerGraph());
        return {};
      })
      .addEdge(START, "delegate")
      .addEdge("delegate", END)
      .compile({ name: "Outer" });

    await gatherIterator(
      outer.stream(
        { messages: [{ role: "user", content: "say hello" }] },
        { streamMode: ["messages", "updates"], subgraphs: true }
      )
    );
    expect(innerText).toMatch(new RegExp(`^${ANSWER} ?$`));
  } finally {
    delete process.env.LANGSMITH_TRACING;
    delete (globalThis as Record<symbol, unknown>)[fetchKey];
  }
});

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
      metadata: { ls_integration: "langgraph" },
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
      run_id: expect.any(String),
      name: "RunnableLambda",
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
      name: "RunnableLambda",
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
      metadata: { ls_integration: "langgraph" },
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
      metadata: { ls_integration: "langgraph" },
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
      metadata: { ls_integration: "langgraph" },
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
      run_id: expect.any(String),
      name: "RunnableLambda",
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
      name: "RunnableLambda",
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
      metadata: { ls_integration: "langgraph" },
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
      metadata: { ls_integration: "langgraph" },
    },
  ]);
});
