/* eslint-disable import/no-extraneous-dependencies */
import type { Server } from "node:http";

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import {
  createNodeWebSocket,
  type NodeWebSocket,
} from "@hono/node-ws";
import {
  createEmbedServer,
  type ThreadSaver,
} from "@langchain/langgraph-api/experimental/embed";
import type { Pregel } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import type { TestProject } from "vitest/node";

import { graph as stategraphText } from "./fixtures/stategraph-text.js";
import { graph as createAgentGraph } from "./fixtures/create-agent.js";
import { graph as deepAgentGraph } from "./fixtures/deep-agent.js";
import { graph as interruptGraph } from "./fixtures/interrupt-graph.js";
import { graph as interruptCardGraph } from "./fixtures/interrupt-card-graph.js";
import { graph as interruptOnceGraph } from "./fixtures/interrupt-once-graph.js";
import { graph as multiInterruptGraph } from "./fixtures/multi-interrupt-graph.js";
import { graph as nestedInterruptGraph } from "./fixtures/nested-interrupt-graph.js";
import { graph as deepAgentInterruptGraph } from "./fixtures/deep-agent-interrupt.js";
import { graph as errorGraph } from "./fixtures/error-graph.js";
import { graph as subgraphGraph } from "./fixtures/subgraph-graph.js";
import { graph as embeddedSubgraphGraph } from "./fixtures/embedded-subgraph-graph.js";
import { graph as customChannelGraph } from "./fixtures/custom-channel-graph.js";
import { graph as slowGraph } from "./fixtures/slow-graph.js";
import { graph as headlessToolGraph } from "./fixtures/headless-tool-graph.js";
import { graph as removeMessageGraph } from "./fixtures/remove-message-graph.js";
import { statefulValuesGraph } from "./fixtures/stateful-values-graph.js";
import { graph as parallelFanoutGraph } from "./fixtures/parallel-fanout.js";
import { graph as parallelSubgraphGraph } from "./fixtures/parallel-subgraph.js";
import { graph as streamingTextGraph } from "./fixtures/streaming-text-graph.js";
import { graph as replyThenInterruptGraph } from "./fixtures/reply-then-interrupt-graph.js";

declare module "vitest" {
  export interface ProvidedContext {
    protocolV2ServerUrl: string;
  }
}

type AnyPregel = Pregel<any, any, any, any, any>;

const threadStore: Record<
  string,
  {
    thread_id: string;
    metadata: Record<string, unknown>;
    created_at: Date;
    updated_at: Date;
  }
> = {};

const threads: ThreadSaver = {
  get: async (id) => threadStore[id],
  set: async (id, { kind, metadata }) => {
    const now = new Date();
    threadStore[id] ??= {
      thread_id: id,
      metadata: {},
      created_at: now,
      updated_at: now,
    };
    threadStore[id].updated_at = now;
    threadStore[id].metadata = {
      ...(kind === "patch" && threadStore[id].metadata),
      ...metadata,
    };
    return threadStore[id];
  },
  delete: async (id) => void delete threadStore[id],
};

const checkpointer = new MemorySaver();

const graphs: Record<string, AnyPregel> = {
  stategraph_text: stategraphText as unknown as AnyPregel,
  create_agent: createAgentGraph as unknown as AnyPregel,
  deep_agent: deepAgentGraph as unknown as AnyPregel,
  interrupt_graph: interruptGraph as unknown as AnyPregel,
  interrupt_card_graph: interruptCardGraph as unknown as AnyPregel,
  interrupt_once_graph: interruptOnceGraph as unknown as AnyPregel,
  multi_interrupt_graph: multiInterruptGraph as unknown as AnyPregel,
  nested_interrupt_graph: nestedInterruptGraph as unknown as AnyPregel,
  deep_agent_interrupt: deepAgentInterruptGraph as unknown as AnyPregel,
  error_graph: errorGraph as unknown as AnyPregel,
  subgraph_graph: subgraphGraph as unknown as AnyPregel,
  embedded_subgraph_graph: embeddedSubgraphGraph as unknown as AnyPregel,
  custom_channel_graph: customChannelGraph as unknown as AnyPregel,
  slow_graph: slowGraph as unknown as AnyPregel,
  headless_tool_graph: headlessToolGraph as unknown as AnyPregel,
  remove_message_graph: removeMessageGraph as unknown as AnyPregel,
  stateful_values_graph: statefulValuesGraph as unknown as AnyPregel,
  parallel_fanout: parallelFanoutGraph as unknown as AnyPregel,
  parallel_subgraph: parallelSubgraphGraph as unknown as AnyPregel,
  streaming_text_graph: streamingTextGraph as unknown as AnyPregel,
  reply_then_interrupt_graph: replyThenInterruptGraph as unknown as AnyPregel,
};

let httpServer: Server | null = null;
let webSocketServer: NodeWebSocket["wss"] | null = null;

/** Live protocol WebSockets per thread. */
const threadSockets = new Map<
  string,
  Set<{ close(code: number, reason: string): void }>
>();
/** Protocol WebSockets each thread has opened, reconnects included. */
const threadSocketOpens = new Map<string, number>();

/**
 * Test controls for a thread's protocol WebSockets. `POST
 * /test-ws/:threadId/close/:code` closes the open ones with `:code`, as
 * LangGraph Platform rejects a socket it accepted with 4000 + the HTTP
 * status; `GET /test-ws/:threadId` returns how many the thread has opened.
 */
function mountWebSocketTestRoutes(app: Hono, wss: NodeWebSocket["wss"]) {
  wss.on("connection", (ws, request) => {
    const threadId = /\/threads\/([^/]+)\/stream\/events/.exec(
      request.url ?? "",
    )?.[1];
    if (threadId == null) return;
    threadSocketOpens.set(threadId, (threadSocketOpens.get(threadId) ?? 0) + 1);
    const sockets = threadSockets.get(threadId) ?? new Set();
    threadSockets.set(threadId, sockets);
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
  });
  app.get("/test-ws/:threadId", (c) =>
    c.json({ opens: threadSocketOpens.get(c.req.param("threadId")) ?? 0 }),
  );
  app.post("/test-ws/:threadId/close/:code", (c) => {
    const sockets = threadSockets.get(c.req.param("threadId")) ?? new Set();
    const code = Number(c.req.param("code"));
    for (const ws of sockets) ws.close(code, "rejected by test server");
    return c.json({ closed: sockets.size });
  });
}

export async function setup({ provide }: TestProject) {
  const app = new Hono();
  app.use(
    "*",
    cors({ origin: "*", exposeHeaders: ["Content-Location"] }),
  );
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({
    app,
  });
  webSocketServer = wss;

  const embedApp = createEmbedServer({
    graph: graphs,
    checkpointer,
    threads,
    upgradeWebSocket,
  });
  mountWebSocketTestRoutes(app, wss);
  app.route("/", embedApp);

  await new Promise<void>((resolve) => {
    httpServer = serve({ fetch: app.fetch, port: 0 }, (info) => {
      const url = `http://localhost:${info.port}`;
      provide("protocolV2ServerUrl", url);
      resolve();
    }) as Server;
    injectWebSocket(httpServer);
  });
}

export async function teardown() {
  for (const client of webSocketServer?.clients ?? []) {
    client.terminate();
  }
  await new Promise<void>((resolve) => {
    if (webSocketServer == null) {
      resolve();
      return;
    }
    webSocketServer.close(() => resolve());
  });
  webSocketServer = null;
  httpServer?.closeAllConnections();
  await new Promise<void>((resolve) => {
    if (httpServer == null) {
      resolve();
      return;
    }
    httpServer.close(() => resolve());
  });
  httpServer = null;
}
