import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatAnthropic } from "@langchain/anthropic";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const model = new ChatAnthropic({
  model: "claude-3-5-sonnet-20240620",
  temperature: 0,
});

const getItems = tool(
  async (input, config) => {
    console.log("RUNNING TOOL");
    const template = ChatPromptTemplate.fromMessages([
      [
        "human",
        "Can you tell me what kind of items i might find in the following place: '{place}'. " +
          "List at least 3 such items separating them by a comma. And include a brief description of each item..",
      ],
    ]);

    const modelWithConfig = model.withConfig({
      runName: "Get Items LLM",
      tags: ["tool_llm"],
    });

    const chain = template.pipe(modelWithConfig);
    const result = await chain.invoke(input, config);
    return result.content;
  },
  {
    name: "get_items",
    description: "Use this tool to look up which items are in the given place.",
    schema: z.object({
      place: z.string(),
    }),
  }
);

const agent = createReactAgent({
  llm: model,
  tools: [getItems],
});

let finalEvent;
for await (const event of agent.streamEvents(
  {
    messages: [
      [
        "human",
        "what items are on the shelf? You should call the get_items tool.",
      ],
    ],
  },
  {
    version: "v2",
  },
  {
    includeTags: ["tool_llm"],
  }
)) {
  console.log(event.data);
  finalEvent = event;
}

const finalMessages = finalEvent?.data.output.messages;
console.dir(
  finalMessages.map((msg: any) => ({
    type: msg._getType(),
    content: msg.content,
    tool_calls: msg.tool_calls,
  })),
  { depth: null }
);
