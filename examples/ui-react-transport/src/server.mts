import {
  StateGraph,
  StateSchema,
  MessagesValue,
  START,
} from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";

import { serve } from "@hono/node-server";
import { Hono } from "hono";

const llm = new ChatOpenAI({ model: "gpt-4o-mini" });

const StateAnnotation = new StateSchema({
  messages: MessagesValue,
});

const graph = new StateGraph(StateAnnotation)
  .addNode("agent", async ({ messages }) => ({
    // Cast needed due to @langchain/core version mismatch in monorepo
    messages: await llm.invoke(messages as unknown as BaseLanguageModelInput),
  }))
  .addEdge(START, "agent")
  .compile();

export type GraphType = typeof graph;

const app = new Hono();

app.post("/api/stream", async (c) => {
  const body = await c.req.json();
  const stream = await graph.stream(body.input, {
    encoding: "text/event-stream",
    streamMode: ["values", "messages", "updates"],
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
});

serve({ fetch: app.fetch, port: 9123 }, (c) => {
  console.log(`Server running at ${c.address}:${c.port}`);
});
