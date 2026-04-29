import type { BaseMessage } from "@langchain/core/messages";
import { tool } from "langchain";
import { createDeepAgent } from "deepagents";
import { z } from "zod/v4";
import { describe, expectTypeOf, test } from "vitest";

import { useStream } from "../index.js";

const searchWeb = tool(
  async ({ query }: { query: string }) => `Found results for ${query}`,
  {
    name: "search_web",
    description: "Search the web",
    schema: z.object({ query: z.string() }),
  }
);

const deepAgent = createDeepAgent({
  tools: [searchWeb],
  subagents: [
    {
      name: "researcher",
      description: "Researches topics",
      systemPrompt: "You are a researcher.",
    },
  ],
});

describe("deep agent stream typing", () => {
  test("messages and values are exposed as signals", () => {
    const stream = useStream<typeof deepAgent>({ assistantId: "deep-agent" });

    expectTypeOf(stream.messages()).toExtend<BaseMessage[]>();
    expectTypeOf(stream.values()).toHaveProperty("messages");
  });

  test("tool calls use assembled v2 protocol fields", () => {
    const stream = useStream<typeof deepAgent>({ assistantId: "deep-agent" });
    const toolCall = stream.toolCalls()[0];

    expectTypeOf(toolCall.name).toEqualTypeOf<string>();
    expectTypeOf(toolCall.callId).toEqualTypeOf<string>();
    expectTypeOf(toolCall.namespace).toEqualTypeOf<string[]>();
    expectTypeOf(toolCall.input).toEqualTypeOf<unknown>();
    expectTypeOf(toolCall.output).toEqualTypeOf<Promise<unknown>>();
  });

  test("subagents are lightweight discovery snapshots", () => {
    const stream = useStream<typeof deepAgent>({ assistantId: "deep-agent" });
    const subagent = [...stream.subagents().values()][0];

    expectTypeOf(subagent.id).toEqualTypeOf<string>();
    expectTypeOf(subagent.name).toEqualTypeOf<string>();
    expectTypeOf(subagent.namespace).toExtend<readonly string[]>();
    expectTypeOf(subagent).not.toHaveProperty("messages");
    expectTypeOf(subagent).not.toHaveProperty("toolCalls");
  });
});
