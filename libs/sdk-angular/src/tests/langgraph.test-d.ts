import type { BaseMessage, StoredMessage } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import { END, MessagesValue, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod/v4";
import { describe, expectTypeOf, test } from "vitest";

import { useStream } from "../index.js";

const GraphSchema = new StateSchema({
  messages: MessagesValue,
  topic: z.string().default(""),
});

const graph = new StateGraph(GraphSchema)
  .addNode("agent", async (state: typeof GraphSchema.State) => ({
    messages: state.messages,
    topic: "research",
  }))
  .addEdge(START, "agent")
  .addEdge("agent", END)
  .compile();

interface DirectState {
  messages: BaseMessage[];
  sessionId: string;
}

describe("StateGraph stream typing", () => {
  test("compiled graph values resolve to the graph state", () => {
    const stream = useStream<typeof graph>({ assistantId: "graph" });

    expectTypeOf(stream.values()).toHaveProperty("messages");
    expectTypeOf(stream.values().topic).toEqualTypeOf<string>();
    expectTypeOf(stream.messages()).toExtend<BaseMessage[]>();
  });

  test("direct state types are supported", () => {
    const stream = useStream<DirectState>({ assistantId: "graph" });

    expectTypeOf(stream.values().sessionId).toEqualTypeOf<string>();
    expectTypeOf(stream.messages()).toExtend<BaseMessage[]>();
  });

  test("core stream methods are available", () => {
    const stream = useStream<typeof graph>({ assistantId: "graph" });

    expectTypeOf(stream.submit(null)).toEqualTypeOf<Promise<void>>();
    expectTypeOf(stream.stop()).toEqualTypeOf<Promise<void>>();
    expectTypeOf(stream.isLoading()).toEqualTypeOf<boolean>();
    expectTypeOf(stream.assistantId).toEqualTypeOf<string>();
  });

  test("submit accepts graph message updates", () => {
    const stream = useStream<typeof graph>({ assistantId: "graph" });

    expectTypeOf(stream.submit).toBeCallableWith(
      { messages: [new HumanMessage("Research AI")] },
      undefined
    );
  });

  test("messages remain serializable class instances", () => {
    const stream = useStream<typeof graph>({ assistantId: "graph" });

    const dicts = stream.messages().map((message) => message.toDict());
    expectTypeOf(dicts).toEqualTypeOf<StoredMessage[]>();
  });
});
