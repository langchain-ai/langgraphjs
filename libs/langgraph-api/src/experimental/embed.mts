import type { BaseCheckpointSaver, BaseStore } from "@langchain/langgraph";
import { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";

import { ensureContentType } from "../http/middleware.mjs";

import type { AnyPregel, EmbedRouteContext } from "./embed/types.mjs";
import { registerThreadRoutes } from "./embed/threads.mjs";
import { registerRunRoutes } from "./embed/runs.mjs";
import { registerProtocolRoutes } from "./embed/protocol.mjs";

export type { ThreadSaver } from "./embed/types.mjs";

/**
 * Create a Hono server with a subset of LangGraph Platform routes.
 *
 * Pass `upgradeWebSocket` to enable the WebSocket protocol transport
 * on `GET /v2/threads/:thread_id/stream`. Create it with `@hono/node-ws`'s
 * `createNodeWebSocket({ app })` and make sure to call `injectWebSocket`
 * on the underlying HTTP server.
 *
 * @experimental Does not follow semver.
 */
export function createEmbedServer(options: {
  graph: Record<string, AnyPregel>;
  threads: import("./embed/types.mjs").ThreadSaver;
  checkpointer: BaseCheckpointSaver;
  store?: BaseStore;
  upgradeWebSocket?: UpgradeWebSocket;
}) {
  async function getGraph(graphId: string) {
    const targetGraph = await options.graph[graphId];
    targetGraph.store = options.store;
    targetGraph.checkpointer = options.checkpointer;
    return targetGraph;
  }

  const context: EmbedRouteContext = {
    graph: options.graph,
    threads: options.threads,
    checkpointer: options.checkpointer,
    store: options.store,
    getGraph,
  };

  const api = new Hono();

  api.use(ensureContentType());

  registerThreadRoutes(api, context);
  registerRunRoutes(api, context);
  registerProtocolRoutes(api, context, options.upgradeWebSocket);

  api.notFound((c) => {
    return c.json(
      { error: `${c.req.method} ${c.req.path} not implemented` },
      404
    );
  });

  return api;
}
