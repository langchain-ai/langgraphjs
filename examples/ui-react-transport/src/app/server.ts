import {
  type CompiledGraphType,
  type StreamTransformer,
  type StreamChannel
} from "@langchain/langgraph";
import type { EventStreamRequest } from "@langchain/protocol";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";

import type { A2AStreamEvent } from "./transformer.js";
import { createA2ATransformer } from "./transformer.js";

type MyCompiledGraph = CompiledGraphType<{
  streamTransformers: [
    StreamTransformer<{ a2a: StreamChannel<A2AStreamEvent>; }>
  ];
}>;

export class CustomGraphServer {
  #app = new Hono();
  #graph: MyCompiledGraph;

  constructor(graph: CompiledGraphType) {
    this.#graph = graph.withConfig({
      streamTransformers: [createA2ATransformer],
    });
    this.#app.post("/api/stream", this.#stream.bind(this));
  }

  /**
   * Streams the events from the graph to the client.
   */
  async #stream(ctx: Context) {
    /**
     * Get stream request parameters.
     */
    const body = await ctx.req.json() as EventStreamRequest;

    /**
     * If user is subscribing to the a2a channel, return the stream of the a2a channel.
     */
    if (body.channels?.includes("custom:a2a")) {
      const stream = await this.#graph.streamEvents(body.input, {
        version: "v3",
      })
      return new Response(stream.extensions.a2a.toEventStream({
        event: "custom",
        serialize: (payload) => JSON.stringify({ name: "a2a", payload }),
      }));
    }

    /**
     * If user is subscribing to the other channels, return the stream of the other channels.
     */
    return new Response(
      await this.#graph.streamEvents(body.input, {
        version: "v3",
        encoding: "text/event-stream",
      })
    );
  }

  /**
   * Start the server.
   */
  async start(port: number) {
    return new Promise((resolve) => serve({
      fetch: this.#app.fetch,
      port,
    }, (c) => resolve({
      host: `${c.address}:${c.port}`,
      cleanup: () => Promise.resolve(),
    })));
  }
}
