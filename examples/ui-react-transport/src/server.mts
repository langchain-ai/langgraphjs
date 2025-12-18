import { StateGraph, MessagesZodState, START } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod/v3";

import { serve } from "@hono/node-server";
import { Hono } from "hono";

const llm = new ChatOpenAI({ model: "gpt-4o-mini" });

const schema = MessagesZodState;

const graph = new StateGraph(schema)
  .addNode("agent", async ({ messages }) => ({
    messages: await llm.invoke(messages),
  }))
  .addEdge(START, "agent")
  .compile();

export type GraphType = typeof graph;

const app = new Hono();

app.post("/api/stream", async (c) => {
  const { input } = z.object({ input: schema }).parse(await c.req.json());

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
