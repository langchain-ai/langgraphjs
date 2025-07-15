import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import { describe, expectTypeOf, it } from "vitest";

import { z as z3 } from "zod/v3";
import { z as z4 } from "zod/v4";
import { z as z4mini } from "zod/v4-mini";

import { type UpdateType, withLangGraph } from "../graph/zod/meta.js";
import {
  MessagesZodMeta,
  MessagesZodState,
} from "../graph/messages_annotation.js";
import type { Messages } from "../graph/message.js";
import { StateGraph } from "../graph/state.js";
import { START } from "../constants.js";
import { registry } from "../graph/zod/zod-registry.js";

describe("zod 3 (prebuilt)", () => {
  const state = MessagesZodState;

  it("update type", () => {
    // We're checking for correct union types here, thus we flip the assertion
    expectTypeOf<{ messages?: Messages | undefined }>().toExtend<
      UpdateType<typeof state>
    >();
  });

  it("state graph", async () => {
    const builder = new StateGraph(state);

    const node = (state: {
      messages: BaseMessage[];
    }): { messages?: Messages } => state;

    // Check for assignability
    const graph = builder.addNode({ node }).addEdge(START, "node").compile();
    await graph.invoke({ messages: "input" });
    await graph.invoke({ messages: [new HumanMessage("input")] });
  });
});

describe("zod 3", () => {
  const state = z3.object({
    messages: withLangGraph(z3.custom<BaseMessage[]>(), MessagesZodMeta),
  });

  it("update type", () => {
    // We're checking for correct union types here, thus we flip the assertion
    expectTypeOf<{ messages?: Messages | undefined }>().toExtend<
      UpdateType<typeof state>
    >();
  });

  it("state graph", async () => {
    const builder = new StateGraph(state);

    const node = (state: {
      messages: BaseMessage[];
    }): { messages?: Messages } => state;

    // Check for assignability
    const graph = builder.addNode({ node }).addEdge(START, "node").compile();
    await graph.invoke({ messages: "input" });
    await graph.invoke({ messages: [new HumanMessage("input")] });
  });
});

describe("zod 4", () => {
  const state = z4.object({
    messages: z4.custom<BaseMessage[]>().register(registry, MessagesZodMeta),
  });

  it("update type", () => {
    // We're checking for correct union types here, thus we flip the assertion
    expectTypeOf<{ messages?: Messages | undefined }>().toExtend<
      UpdateType<typeof state>
    >();
  });

  it("state graph", async () => {
    const builder = new StateGraph(state);

    const node = (state: {
      messages: BaseMessage[];
    }): { messages?: Messages } => state;

    // Check for assignability
    const graph = builder.addNode({ node }).addEdge(START, "node").compile();
    await graph.invoke({ messages: "input" });
    await graph.invoke({ messages: [new HumanMessage("input")] });
  });
});

describe("zod 4 mini", () => {
  const state = z4mini.object({
    messages: z4mini
      .custom<BaseMessage[]>()
      .register(registry, MessagesZodMeta),
  });

  it("update type", () => {
    // We're checking for correct union types here, thus we flip the assertion
    expectTypeOf<{ messages?: Messages | undefined }>().toExtend<
      UpdateType<typeof state>
    >();
  });

  it("state graph", async () => {
    const builder = new StateGraph(state);

    const node = (state: {
      messages: BaseMessage[];
    }): { messages?: Messages } => state;

    // Check for assignability
    const graph = builder.addNode({ node }).addEdge(START, "node").compile();
    await graph.invoke({ messages: "input" });
    await graph.invoke({ messages: [new HumanMessage("input")] });
  });
});
