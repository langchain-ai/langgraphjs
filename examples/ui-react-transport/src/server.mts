import { StateGraph, MessagesZodState, START } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";

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
