import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  StateGraph,
  MessagesAnnotation,
  interrupt,
  pushMessage,
  START,
  END,
  type Runtime,
  type Pregel,
} from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import {
  AIMessage,
  BaseMessage,
  RemoveMessage,
} from "@langchain/core/messages";
import {
  createEmbedServer,
  type ThreadSaver,
} from "@langchain/langgraph-api/experimental/embed";
import type { Message } from "@langchain/langgraph-sdk";
import { randomUUID } from "node:crypto";
import type { TestProject } from "vitest/node";

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
        metadata: { ...(THREADS[threadId]?.metadata ?? {}), ...metadata },
      };
      return THREADS[threadId];
    },
    delete: async (threadId) => void delete THREADS[threadId],
  };
})();

const checkpointer = new MemorySaver();

const model = new FakeStreamingChatModel({
  responses: [new AIMessage("Hey")],
  sleep: 100,
});

const agent = new StateGraph(MessagesAnnotation)
  .addNode(
    "agent",
    async (state: { messages: Message[] }, runtime: Runtime) => {
      runtime.writer?.("Custom events");
      const response = await model.invoke(state.messages);
      return { messages: [response] };
    }
  )
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

const graphs: Record<string, AnyPregel> = {
  agent,
  interruptAgent,
  parentAgent,
  removeMessageAgent,
};

let httpServer: { close: () => void } | null = null;

export async function setup({ provide }: TestProject) {
  const embedApp = createEmbedServer({ graph: graphs, checkpointer, threads });
  const app = new Hono();
  app.use("*", cors());
  app.route("/", embedApp);

  await new Promise<void>((resolve) => {
    httpServer = serve({ fetch: app.fetch, port: 0 }, (info) => {
      const url = `http://localhost:${info.port}`;
      provide("serverUrl", url);
      console.log(`Mock server started at ${url}`);
      resolve();
    });
  });
}

export async function teardown() {
  httpServer?.close();
}
