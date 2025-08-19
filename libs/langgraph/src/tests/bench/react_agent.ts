/* eslint-disable no-promise-executor-return */
/* eslint-disable import/order */
/* eslint-disable import/first */
import { v4 as uuid } from "uuid";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod/v3";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { createReactAgent } from "../../prebuilt/index.js";
import { FakeToolCallingChatModel } from "../utils.models.js";

/**
 * Creates a React agent with specified number of tools for benchmarking.
 */
export function reactAgent(nTools: number, checkpointer?: MemorySaver) {
  // Create a tool that simulates work
  const testTool = tool(
    ({ query }) => `result for query: ${query}`.repeat(10),
    {
      name: `tool_${uuid()}`,
      description: "A test tool",
      schema: z.object({
        query: z.string().describe("The query parameter"),
      }),
    }
  );

  // Create fake model with tool call responses
  const model = new FakeToolCallingChatModel({
    responses: [
      // Create n_tools number of tool calling responses
      ...Array.from(
        { length: nTools },
        () =>
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: uuid(),
                name: testTool.name,
                args: { query: uuid().repeat(100) },
              },
            ],
            id: uuid(),
          })
      ),

      // Final response
      new AIMessage({ content: "answer".repeat(100), id: uuid() }),
    ],
  });

  return createReactAgent({
    llm: model,
    tools: [testTool],
    checkpointSaver: checkpointer,
  });
}

import { fileURLToPath } from "node:url";
import * as inspector from "node:inspector";

async function main() {
  const checkpointer = new MemorySaver();
  const graph = reactAgent(100, checkpointer);

  const input = { messages: [new HumanMessage("hi?")] };
  const config = {
    recursionLimit: 20000000000,
    configurable: { thread_id: "1" },
  };

  const result = [];
  console.time("stream");
  for await (const chunk of await graph.stream(input, config)) {
    result.push(chunk);
  }
  console.timeEnd("stream");

  if (inspector.url()) {
    await new Promise((resolve) => setTimeout(resolve, 360_000));
  }

  return result.length;
}

if (import.meta.url.startsWith("file:")) {
  const modulePath = fileURLToPath(import.meta.url);
  if (process.argv[1] === modulePath) {
    void main();
  }
}
