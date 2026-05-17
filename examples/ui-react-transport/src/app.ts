import {
    StateGraph,
    StateSchema,
    MessagesValue,
    START,
} from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";

import { CustomServer } from "./app/server.ts";

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

const server = new CustomServer(graph);
await server.start(9123);
