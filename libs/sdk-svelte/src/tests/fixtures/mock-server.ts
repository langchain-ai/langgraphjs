/* eslint-disable import/no-extraneous-dependencies */
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  RemoveMessage,
} from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import {
  createEmbedServer,
  type ThreadSaver,
} from "@langchain/langgraph-api/experimental/embed";
import {
  StateGraph,
  MessagesAnnotation,
  Annotation,
  Command,
  interrupt,
  pushMessage,
  Send,
  START,
  END,
  type Runtime,
  type Pregel,
} from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { tool, ToolMessage, createAgent } from "langchain";
import { z } from "zod/v4";
import { createDeepAgent, type DeepAgent } from "deepagents";

import type { Message } from "@langchain/langgraph-sdk";
import type { TestProject } from "vitest/node";

import { getLocationTool } from "./browser-fixtures.js";
import { graph as multiInterruptGraph } from "./multi-interrupt-graph.js";

declare module "vitest" {
  export interface ProvidedContext {
    serverUrl: string;
  }
}

type AnyPregel = Pregel<any, any, any, any, any>;

const threads: ThreadSaver = (() => {
  const THREADS: Record<
    string,
    { thread_id: string; metadata: Record<string, unknown> }
  > = {};

  return {
    get: async (id) => THREADS[id],
    set: async (threadId, { metadata }) => {
      THREADS[threadId] = {
        thread_id: threadId,
        metadata: { ...THREADS[threadId]?.metadata, ...metadata },
      };
      return THREADS[threadId];
    },
    delete: async (threadId) => void delete THREADS[threadId],
  };
})();

const checkpointer = new MemorySaver();

const model = new FakeStreamingChatModel({
  responses: [new AIMessage("Hey")],
  sleep: 300,
});

const agent = new StateGraph(MessagesAnnotation)
  .addNode(
    "agent",
    async (state: { messages: Message[] }, runtime: Runtime) => {
      runtime.writer?.("Custom events");
      const response = await model.invoke(state.messages);
      return { messages: [response] };
    },
  )
  .addEdge(START, "agent")
  .compile();

const stategraphText = new StateGraph(MessagesAnnotation)
  .addNode("agent", async () => {
    return { messages: [new AIMessage("Plan accepted.")] };
  })
  .addEdge(START, "agent")
  .compile();

const interruptAgent = new StateGraph(MessagesAnnotation)
  .addNode("beforeInterrupt", async () => {
    return { messages: [new AIMessage("Before interrupt")] };
  })
  .addNode("agent", async () => {
    const resume = interrupt({ nodeName: "agent" });
    return { messages: [new AIMessage(`Hey: ${resume}`)] };
  })
  .addNode("afterInterrupt", async () => {
    return { messages: [new AIMessage("After interrupt")] };
  })
  .addEdge(START, "beforeInterrupt")
  .addEdge("beforeInterrupt", "agent")
  .addEdge("agent", "afterInterrupt")
  .addEdge("afterInterrupt", END)
  .compile();

const parentAgent = new StateGraph(MessagesAnnotation)
  .addNode("child", agent, { subgraphs: [agent] })
  .addEdge(START, "child")
  .compile();

const researchSubgraph = new StateGraph(MessagesAnnotation)
  .addNode(
    "inner",
    async (_state: { messages: BaseMessage[] }, runtime: Runtime) => {
      runtime.writer?.({ type: "progress", label: "research-started" });
      runtime.writer?.({ type: "progress", label: "research-finished" });
      return { messages: [new AIMessage("Subgraph reply")] };
    },
  )
  .addEdge(START, "inner")
  .compile();

async function research(state: { messages: BaseMessage[] }) {
  const result = await researchSubgraph.invoke({
    messages: state.messages,
  });
  const last = result.messages.at(-1);
  return {
    messages: [
      new AIMessage(
        typeof last?.content === "string" ? last.content : "Research done",
      ),
    ],
  };
}

async function summarize(_state: { messages: BaseMessage[] }) {
  return {
    messages: [new AIMessage("Summary line")],
  };
}

const embeddedSubgraphAgent = new StateGraph(MessagesAnnotation)
  .addNode("research", research, { subgraphs: [researchSubgraph] })
  .addNode("summarize", summarize)
  .addEdge(START, "research")
  .addEdge("research", "summarize")
  .compile();

const customChannelAgent = new StateGraph(MessagesAnnotation)
  .addNode("agent", async (_state, runtime: Runtime) => {
    runtime.writer?.({ stage: "thinking" });
    runtime.writer?.({ name: "status", payload: { label: "answering" } });
    runtime.writer?.({ stage: "done" });
    return { messages: [new AIMessage("Custom channel reply")] };
  })
  .addEdge(START, "agent")
  .compile();

const removeMessageAgent = new StateGraph(MessagesAnnotation)
  .addSequence({
    step1: () => ({ messages: [new AIMessage("Step 1: To Remove")] }),
    step2: async (state) => {
      const messages: BaseMessage[] = [
        ...state.messages
          .filter((m) => AIMessage.isInstance(m))
          .map((m) => new RemoveMessage({ id: m.id! })),
        new AIMessage({ id: randomUUID(), content: "Step 2: To Keep" }),
      ];

      for (const message of messages) {
        pushMessage(message, { stateKey: null });
      }

      return { messages };
    },
    step3: () => ({ messages: [new AIMessage("Step 3: To Keep")] }),
  })
  .addEdge(START, "step1")
  .compile();

const errorAgent = new StateGraph(MessagesAnnotation)
  .addNode("agent", async () => {
    throw new Error("Intentional error for testing");
  })
  .addEdge(START, "agent")
  .compile();

const slowGraph = new StateGraph(MessagesAnnotation)
  .addNode("agent", async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { messages: [new AIMessage("Done.")] };
  })
  .addEdge(START, "agent")
  .compile();

// State with a non-message channel alongside `messages`, used to
// exercise optimistic handling of non-message input keys. Sleeps
// before overwriting `status` with the server-authoritative value.
const StatefulState = Annotation.Root({
  ...MessagesAnnotation.spec,
  status: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "idle",
  }),
});

const statefulValuesGraph = new StateGraph(StatefulState)
  .addNode("agent", async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { messages: [new AIMessage("Done.")], status: "final" };
  })
  .addEdge(START, "agent")
  .compile();

// --- Fake Model for Tool-Calling Agents ---
class FakeToolCallingModel extends BaseChatModel {
  responses: BaseMessage[];

  callCount = 0;

  constructor(fields: { responses: BaseMessage[] } & BaseChatModelParams) {
    super(fields);
    this.responses = fields.responses;
  }

  _llmType() {
    return "fake-tool-calling";
  }

  _combineLLMOutput() {
    return [];
  }

  private _resolveContent(
    baseMsg: BaseMessage,
    messages?: BaseMessage[],
  ): string {
    const base = (baseMsg.content as string) || "";
    if ((baseMsg as AIMessage).tool_calls?.length || !messages?.length)
      return base;

    const toolOutputs = messages
      .filter(ToolMessage.isInstance)
      .map((m) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      );
    return toolOutputs.length > 0
      ? `${base} Tool output: ${toolOutputs.join("; ")}`
      : base;
  }

  async _generate(messages?: BaseMessage[]): Promise<ChatResult> {
    const baseMsg = this.responses[this.callCount % this.responses.length];
    this.callCount += 1;
    const content = this._resolveContent(baseMsg, messages);
    const msg =
      content !== ((baseMsg.content as string) || "")
        ? new AIMessage(content)
        : baseMsg;
    return {
      generations: [{ text: (msg.content as string) || "", message: msg }],
    };
  }

  async *_streamResponseChunks(messages?: BaseMessage[]) {
    const baseMsg = this.responses[this.callCount % this.responses.length];
    const content = this._resolveContent(baseMsg, messages);

    const chunkFields: Record<string, unknown> = { content };
    if (baseMsg.id != null) {
      chunkFields.id = baseMsg.id;
    }

    const toolCalls = (baseMsg as AIMessage).tool_calls;
    if (toolCalls?.length) {
      chunkFields.tool_call_chunks = toolCalls.map(
        (
          tc: { name: string; args: Record<string, unknown>; id?: string },
          index: number,
        ) => ({
          name: tc.name,
          args: JSON.stringify(tc.args),
          id: tc.id,
          index,
          type: "tool_call_chunk" as const,
        }),
      );
    }

    yield new ChatGenerationChunk({
      message: new AIMessageChunk(chunkFields),
      text: content,
    });

    this.callCount += 1;
  }

  bindTools() {
    return this;
  }
}

// --- Deep Agent with 2 Subagents and Custom Tools ---

const searchWebTool = tool(
  async ({ query }: { query: string }) => {
    await new Promise((r) => {
      setTimeout(r, 100);
    });
    return JSON.stringify({
      status: "success",
      query,
      results: [
        { title: `Result for: ${query}`, url: "https://example.com/1" },
        { title: `More on: ${query}`, url: "https://example.com/2" },
      ],
    });
  },
  {
    name: "search_web",
    description: "Search the web for information on a topic",
    schema: z.object({
      query: z.string().describe("The search query"),
    }),
  },
);

// Returns a Command with state update (like deepagents' write_file/edit_file)
// to test that ToolMessages embedded in Commands are properly routed
const queryDatabaseTool = tool(
  async ({ table }: { table: string }, config) => {
    await new Promise((r) => {
      setTimeout(r, 100);
    });
    const content = JSON.stringify({
      status: "success",
      table,
      records: [
        { id: 1, name: "Record A", value: 42 },
        { id: 2, name: "Record B", value: 87 },
      ],
      count: 2,
    });
    return new Command({
      update: {
        messages: [
          new ToolMessage({
            content,
            tool_call_id: config.toolCall?.id as string,
            name: "query_database",
          }),
        ],
      },
    });
  },
  {
    name: "query_database",
    description: "Query a database table with optional filters",
    schema: z.object({
      table: z.string().describe("The table name to query"),
    }),
  },
);

const deepOrchestratorModel = new FakeToolCallingModel({
  responses: [
    new AIMessage({
      id: "deep-orchestrator-tool-call",
      content: "",
      tool_calls: [
        {
          name: "task",
          args: {
            description: "Search the web for test research query",
            subagent_type: "researcher",
          },
          id: "task-1",
          type: "tool_call",
        },
        {
          name: "task",
          args: {
            description: "Query the database for test data",
            subagent_type: "data-analyst",
          },
          id: "task-2",
          type: "tool_call",
        },
      ],
    }),
    new AIMessage({
      id: "deep-orchestrator-final",
      content: "Both agents completed their tasks successfully.",
    }),
  ],
});

const deepResearcherModel = new FakeToolCallingModel({
  responses: [
    new AIMessage({
      id: "search-1-message",
      content: "",
      tool_calls: [
        {
          name: "search_web",
          args: { query: "test research query" },
          id: "search-1",
          type: "tool_call",
        },
      ],
    }),
    new AIMessage({
      id: "search-1-final",
      content: "Research completed: found relevant results.",
    }),
  ],
});

const deepAnalystModel = new FakeToolCallingModel({
  responses: [
    new AIMessage({
      id: "query-1-message",
      content: "",
      tool_calls: [
        {
          name: "query_database",
          args: { table: "test_data" },
          id: "query-1",
          type: "tool_call",
        },
      ],
    }),
    new AIMessage({
      id: "query-1-final",
      content: "Analysis completed: found 2 records.",
    }),
  ],
});

const deepAgentGraph: DeepAgent = createDeepAgent({
  model: deepOrchestratorModel,
  subagents: [
    {
      name: "researcher",
      description: "Research specialist that searches the web for information.",
      systemPrompt: "You are a research specialist.",
      tools: [searchWebTool],
      model: deepResearcherModel,
    },
    {
      name: "data-analyst",
      description: "Data analysis expert that queries databases for insights.",
      systemPrompt: "You are a data analysis expert.",
      tools: [queryDatabaseTool],
      model: deepAnalystModel,
    },
  ],
  systemPrompt: "You are an AI coordinator that delegates tasks.",
});

// --- Parallel fan-out fixtures (subagents + subgraphs) ---

const FANOUT_WORKER_COUNT = 6;

const fanoutOrchestratorModel = new FakeToolCallingModel({
  responses: [
    new AIMessage({
      content: "",
      tool_calls: Array.from({ length: FANOUT_WORKER_COUNT }, (_, i) => ({
        name: "task",
        args: {
          description: `Worker worker-${String(i + 1).padStart(
            3,
            "0"
          )} covering topic ${i + 1}`,
          subagent_type: "worker",
        },
        id: `task-${i + 1}`,
        type: "tool_call" as const,
      })),
    }),
    new AIMessage("All workers completed."),
  ],
});

const fanoutWorkerModel = new FakeToolCallingModel({
  responses: [new AIMessage("Worker done.")],
});

const parallelFanoutGraph: DeepAgent = createDeepAgent({
  model: fanoutOrchestratorModel,
  subagents: [
    {
      name: "worker",
      description: "A worker that completes a single delegated subtask.",
      systemPrompt: "You are a worker. Complete the task and report back.",
      tools: [],
      model: fanoutWorkerModel,
    },
  ],
  systemPrompt: "You are a coordinator that fans out work to many workers.",
});

const SUBGRAPH_WORKER_COUNT = 6;

const parallelSubgraphWorkerModel = new FakeStreamingChatModel({
  responses: [new AIMessage("Subgraph reply")],
});

const parallelSubgraphChild = new StateGraph(MessagesAnnotation)
  .addNode("inner", async (state: { messages: BaseMessage[] }) => {
    const response = await parallelSubgraphWorkerModel.invoke(state.messages);
    return { messages: [response] };
  })
  .addEdge(START, "inner")
  .compile();

const parallelSubgraphGraph = new StateGraph(MessagesAnnotation)
  .addNode("worker", parallelSubgraphChild, {
    subgraphs: [parallelSubgraphChild],
  })
  .addConditionalEdges(START, () =>
    Array.from(
      { length: SUBGRAPH_WORKER_COUNT },
      (_, i) =>
        new Send("worker", {
          messages: [new HumanMessage(`Subtask ${i + 1}`)],
        })
    )
  )
  .compile();

/**
 * Stateless model for headless tool tests. Inspects incoming messages instead
 * of using a call counter, so retries never receive a stale response.
 */
class FakeHeadlessToolModel extends BaseChatModel {
  constructor() {
    super({});
  }

  _llmType() {
    return "fake-browser-tool";
  }

  _combineLLMOutput() {
    return [];
  }

  private _needsToolCall(messages?: BaseMessage[]) {
    return !messages?.some((m) => m.getType() === "tool");
  }

  async _generate(messages?: BaseMessage[]): Promise<ChatResult> {
    const msg = this._needsToolCall(messages)
      ? new AIMessage({
          content: "",
          tool_calls: [
            {
              name: "get_location",
              args: { highAccuracy: false },
              id: "tool-call-browser-1",
              type: "tool_call",
            },
          ],
        })
      : new AIMessage("Location received!");
    return {
      generations: [{ text: (msg.content as string) || "", message: msg }],
    };
  }

  async *_streamResponseChunks(messages?: BaseMessage[]) {
    if (this._needsToolCall(messages)) {
      yield new ChatGenerationChunk({
        message: new AIMessageChunk({
          content: "",
          tool_call_chunks: [
            {
              name: "get_location",
              args: JSON.stringify({ highAccuracy: false }),
              id: "tool-call-browser-1",
              index: 0,
              type: "tool_call_chunk",
            },
          ],
        }),
        text: "",
      });
    } else {
      yield new ChatGenerationChunk({
        message: new AIMessageChunk("Location received!"),
        text: "Location received!",
      });
    }
  }

  bindTools() {
    return this;
  }
}

const headlessToolModel = new FakeHeadlessToolModel();

const headlessToolAgent = createAgent({
  model: headlessToolModel,
  tools: [getLocationTool],
  checkpointer,
}) as unknown as AnyPregel;

// --- HITL card flow: interrupt raised from inside a tool ---
// Mirrors a customer pattern where the interrupt carries an AIMessage
// "card" (in `response_metadata.cards`) the frontend renders validation
// buttons from. The tool's real work is slow, so the frontend pushes the
// card into state alongside the resume (`respond(decision, { update })`) —
// the backend never adds it — so the card stays visible without flicker.
const reviewActionTool = tool(
  async ({ toolArg }: { toolArg: string }) => {
    const card = {
      kind: "tool_validation",
      action: toolArg,
      buttons: ["approve", "reject"],
    };
    const response = interrupt({
      type: "ai",
      content: `Please review the "${toolArg}" action.`,
      response_metadata: { cards: card },
    });
    const approved =
      response === true ||
      (response != null &&
        typeof response === "object" &&
        (response as { approved?: unknown }).approved === true);
    if (!approved) {
      return "User has rejected the toolcall";
    }
    // Long-running business logic — the FE-pushed card must stay in state
    // for the entire duration (the no-flicker guarantee).
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return `Executed "${toolArg}".`;
  },
  {
    name: "review_action",
    description: "Perform a sensitive action that requires human approval.",
    schema: z.object({ toolArg: z.string() }),
  },
);

const interruptCardModel = new FakeToolCallingModel({
  responses: [
    new AIMessage({
      content: "",
      tool_calls: [
        {
          name: "review_action",
          args: { toolArg: "delete_db" },
          id: "call-review-1",
          type: "tool_call",
        },
      ],
    }),
    new AIMessage("Done."),
  ],
});

const interruptCardGraph = createAgent({
  model: interruptCardModel,
  tools: [reviewActionTool],
  systemPrompt: "You are a deterministic approval agent for protocol testing.",
  checkpointer,
}) as unknown as AnyPregel;

const graphs: Record<string, AnyPregel> = {
  agent,
  stategraph_text: stategraphText,
  interruptAgent,
  interrupt_card_graph: interruptCardGraph,
  multi_interrupt_graph: multiInterruptGraph as unknown as AnyPregel,
  parentAgent,
  embedded_subgraph_graph: embeddedSubgraphAgent,
  removeMessageAgent,
  errorAgent,
  slow_graph: slowGraph,
  stateful_values_graph: statefulValuesGraph,
  customChannelAgent,
  headlessToolAgent,
  deepAgent: deepAgentGraph as unknown as AnyPregel,
  parallel_fanout: parallelFanoutGraph as unknown as AnyPregel,
  parallel_subgraph: parallelSubgraphGraph as unknown as AnyPregel,
};

let httpServer: Server | null = null;

export async function setup({ provide }: TestProject) {
  const app = new Hono();
  app.use("*", cors({ origin: "*", exposeHeaders: ["Content-Location"] }));
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const embedApp = createEmbedServer({
    graph: graphs,
    checkpointer,
    threads,
    upgradeWebSocket,
  });
  app.route("/", embedApp);

  await new Promise<void>((resolve) => {
    httpServer = serve({ fetch: app.fetch, port: 0 }, (info) => {
      const url = `http://localhost:${info.port}`;
      provide("serverUrl", url);
      console.log(`Mock server started at ${url}`);
      resolve();
    }) as Server;
    injectWebSocket(httpServer);
  });
}

export async function teardown() {
  httpServer?.closeAllConnections();
  httpServer?.close();
  httpServer = null;
}
