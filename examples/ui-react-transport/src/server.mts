import type { BaseMessage } from "@langchain/core/messages";
import {
  Annotation,
  StateGraph,
  messagesStateReducer,
  START,
} from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod/v4";

const llm = new ChatOpenAI({ model: "gpt-4o-mini" });

const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});

const schema = z.object({
  messages: z.custom<BaseMessage[]>(),
});

const graph = new StateGraph(StateAnnotation)
  .addNode("agent", async ({ messages }) => ({
    messages: await llm.invoke(messages),
  }))
  .addEdge(START, "agent")
  .compile();

export type GraphType = typeof graph;

const app = new Hono();

app.post("/api/stream", async (c) => {
  const body = await c.req.json();
  const input = schema.parse(body.input);

  const stream = await graph.stream(input, {
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
