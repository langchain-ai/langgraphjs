import type { BaseMessage } from "@langchain/core/messages";
import { StateGraph, MessagesZodMeta, START } from "@langchain/langgraph";
import { registry } from "@langchain/langgraph/zod";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod/v4";

const llm = new ChatOpenAI({ model: "gpt-4o-mini" });

const schema = z.object({
  messages: z.custom<BaseMessage[]>().register(registry, MessagesZodMeta),
});

export const graph = new StateGraph(schema)
  .addNode("agent", async ({ messages }) => ({
    messages: await llm.invoke(messages),
  }))
  .addEdge(START, "agent")
  .compile();
