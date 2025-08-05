import { describe, expect, it } from "vitest";
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import { AIMessage, BaseMessage } from "@langchain/core/messages";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { ChatResult } from "@langchain/core/outputs";
import { BaseLLMParams } from "@langchain/core/language_models/llms";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { createSwarm } from "./swarm.js";
import { createHandoffTool } from "./handoff.js";

class FakeChatModel extends FakeStreamingChatModel {
  idx: number;

  constructor(
    fields: {
      sleep?: number;
      responses?: BaseMessage[];
      thrownErrorString?: string;
    } & BaseLLMParams
  ) {
    super(fields);
    this.idx = 0;
    this.sleep = fields.sleep ?? this.sleep;
    this.responses = fields.responses ?? [];
    this.thrownErrorString = fields.thrownErrorString;
  }

  async _generate(
    _: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    if (this.thrownErrorString) {
      throw new Error(this.thrownErrorString);
    }

    const generation: ChatResult = {
      generations: [
        {
          text: "",
          message: this.responses![this.idx],
        },
      ],
    };

    this.idx += 1;
    return generation;
  }
}

describe("Swarm", () => {
  it("should run in basic case", async () => {
    const recordedMessages = [
      new AIMessage({
        id: "1",
        content: "",
        name: "Alice",
        tool_calls: [
          {
            name: "transfer_to_bob",
            args: {},
            id: "call_1LlFyjm6iIhDjdn7juWuPYr4",
          },
        ],
      }),
      new AIMessage({
        id: "2",
        content:
          "Ahoy, matey! Bob the pirate be at yer service. What be ye needin' help with today on the high seas? Arrr!",
        name: "Bob",
      }),
      new AIMessage({
        id: "3",
        content: "",
        name: "Bob",
        tool_calls: [
          {
            name: "transfer_to_alice",
            args: {},
            id: "call_T6pNmo2jTfZEK3a9avQ14f8Q",
          },
        ],
      }),
      new AIMessage({
        id: "4",
        content: "",
        name: "Alice",
        tool_calls: [
          {
            name: "add",
            args: {
              a: 5,
              b: 7,
            },
            id: "call_4kLYO1amR2NfhAxfECkALCr1",
          },
        ],
      }),
      new AIMessage({
        id: "5",
        content: "The sum of 5 and 7 is 12.",
        name: "Alice",
      }),
    ];
    const model = new FakeChatModel({
      responses: recordedMessages,
    });
    model.bindTools = () => {
      return model;
    };

    const add = tool(async (args) => args.a + args.b, {
      name: "add",
      description: "Add two numbers.",
      schema: z.object({
        a: z.number(),
        b: z.number(),
      }),
    });

    // Create agents with handoff tools
    const alice = createReactAgent({
      llm: model,
      tools: [add, createHandoffTool({ agentName: "Bob" })],
      name: "Alice",
      prompt: "You are Alice, an addition expert.",
    });

    const bob = createReactAgent({
      llm: model,
      tools: [
        createHandoffTool({
          agentName: "Alice",
          description: "Transfer to Alice, she can help with math",
        }),
      ],
      name: "Bob",
      prompt: "You are Bob, you speak like a pirate.",
    });

    // Create swarm workflow
    const checkpointer = new MemorySaver();
    const workflow = createSwarm({
      agents: [alice, bob],
      defaultActiveAgent: "Alice",
    });

    const app = workflow.compile({
      name: "swarm_demo",
      checkpointer,
    });

    // Example usage
    const config = { configurable: { thread_id: "1" } };

    const turn1 = await app.invoke(
      { messages: [{ role: "user", content: "i'd like to speak to Bob" }] },
      config
    );

    expect(turn1.messages.length).toBe(4);
    expect(turn1.messages.at(-2)?.content).toBe(
      "Successfully transferred to Bob"
    );
    expect(turn1.messages.at(-1)?.content).toBe(recordedMessages[1].content);
    expect(turn1.activeAgent).toBe("Bob");

    const turn2 = await app.invoke(
      { messages: [{ role: "user", content: "what's 5 + 7?" }] },
      config
    );

    expect(turn2.messages.length).toBe(10);
    expect(turn2.messages.at(-4)?.content).toBe(
      "Successfully transferred to Alice"
    );
    expect((turn2.messages.at(-3) as AIMessage)?.tool_calls).toBe(
      recordedMessages[3].tool_calls
    );
    expect(turn2.messages.at(-2)?.content).toBe("12");
    expect(turn2.messages.at(-1)?.content).toBe(recordedMessages[4].content);
    expect(turn2.activeAgent).toBe("Alice");
  });
});
