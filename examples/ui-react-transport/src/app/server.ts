import type { CompiledGraphType } from "@langchain/langgraph";
import type { Command, SubscribeParams } from "@langchain/protocol";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";

import { LocalThreadSession, type LocalProtocolGraph } from "./session.js";
import { createA2ATransformer } from "./transformer.js";

/**
 * Minimal HTTP server that exposes an in-process LangGraph, ReAct or
 * DeepAgent through the Agent Streaming Protocol endpoints consumed
 * by `HttpAgentServerAdapter`.
 *
 * The server keeps one {@link LocalThreadSession} per thread id. Each session
 * owns its event replay buffer and active SSE subscribers, while this class is
 * responsible for routing protocol commands and stream subscriptions to the
 * right session.
 */
export class CustomServer {
  #app = new Hono();
  #graph: LocalProtocolGraph;
  #sessions = new Map<string, LocalThreadSession>();

  /**
   * Configure the graph with the example A2A stream transformer and register
   * the protocol HTTP routes.
   *
   * @param graph - Compiled graph to run for every local thread session.
   */
  constructor(graph: CompiledGraphType) {
    this.#graph = graph.withConfig({
      streamTransformers: [createA2ATransformer],
    });
    this.#app.post(
      "/api/threads/:threadId/commands",
      this.#commands.bind(this)
    );
    this.#app.post("/api/threads/:threadId/stream", this.#stream.bind(this));
  }

  /**
   * Get or create the process-local session for a thread.
   *
   * This example stores sessions in memory. Production servers should back
   * this with durable thread state and a replay buffer shared across workers.
   */
  #session(threadId: string) {
    let session = this.#sessions.get(threadId);
    if (session == null) {
      session = new LocalThreadSession(this.#graph);
      this.#sessions.set(threadId, session);
    }
    return session;
  }

  /**
   * Handle `POST /api/threads/:threadId/commands`.
   *
   * The request body is an Agent Protocol {@link Command}. The response is the
   * command result emitted by the owning {@link LocalThreadSession}.
   */
  async #commands(ctx: Context) {
    const threadId = ctx.req.param("threadId") ?? "local";
    const command = (await ctx.req.json()) as Command;
    return ctx.json(await this.#session(threadId).handleCommand(command));
  }

  /**
   * Handle `POST /api/threads/:threadId/stream`.
   *
   * The request body is a connection-scoped {@link SubscribeParams} filter.
   * The response is an SSE stream that first replays matching buffered events
   * and then stays attached for live events from the same thread.
   */
  async #stream(ctx: Context) {
    const threadId = ctx.req.param("threadId") ?? "local";
    const params = (await ctx.req.json()) as SubscribeParams;

    return new Response(this.#session(threadId).stream(params), {
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/event-stream",
      },
    });
  }

  /**
   * Start serving the protocol routes on the given port.
   *
   * @param port - TCP port for the local Hono server.
   * @returns Server metadata used by the example runner.
   */
  async start(port: number) {
    return new Promise((resolve) =>
      serve(
        {
          fetch: this.#app.fetch,
          port,
        },
        (c) =>
          resolve({
            host: `${c.address}:${c.port}`,
            cleanup: () => Promise.resolve(),
          })
      )
    );
  }
}
