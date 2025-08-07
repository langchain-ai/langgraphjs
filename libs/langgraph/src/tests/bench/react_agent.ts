import { v4 as uuid } from "uuid";
import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod/v3";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { createReactAgent } from "../../prebuilt/index.js";
import { FakeToolCallingChatModel } from "../utils.js";

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
