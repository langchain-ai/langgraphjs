import { createAgent, tool } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod/v4";

const model = new ChatOpenAI({ model: "gpt-4o-mini" });

/**
 * A simple calculator tool to demonstrate branching with tool calls
 */
export const calculate = tool(
  async ({ expression }) => {
    try {
      // Simple safe evaluation for basic math
      const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, "");
      // eslint-disable-next-line no-eval
      const result = Function(`"use strict"; return (${sanitized})`)();
      return JSON.stringify({
        status: "success",
        expression,
        result: Number(result),
      });
    } catch {
      return JSON.stringify({
        status: "error",
        content: `Could not evaluate: ${expression}`,
      });
    }
  },
  {
    name: "calculate",
    description: "Evaluate a mathematical expression",
    schema: z.object({
      expression: z
        .string()
        .describe("The mathematical expression to evaluate (e.g., '2 + 2')"),
    }),
  }
);

/**
 * A simple facts tool that returns random facts
 */
export const getFact = tool(
  async ({ topic }) => {
    const facts: Record<string, string[]> = {
      science: [
        "Honey never spoils - archaeologists have found 3000-year-old honey in Egyptian tombs that was still edible.",
        "Octopuses have three hearts and blue blood.",
        "A day on Venus is longer than a year on Venus.",
      ],
      history: [
        "Cleopatra lived closer in time to the Moon landing than to the construction of the Great Pyramid.",
        "Oxford University is older than the Aztec Empire.",
        "The Eiffel Tower can grow up to 6 inches taller during summer due to thermal expansion.",
      ],
      nature: [
        "Trees can communicate with each other through underground fungal networks.",
        "Crows can recognize human faces and hold grudges.",
        "Bananas are berries, but strawberries are not.",
      ],
    };

    const topicFacts = facts[topic.toLowerCase()] || facts.science;
    const randomFact = topicFacts[Math.floor(Math.random() * topicFacts.length)];

    return JSON.stringify({
      status: "success",
      topic,
      fact: randomFact,
    });
  },
  {
    name: "get_fact",
    description: "Get a random interesting fact about a topic",
    schema: z.object({
      topic: z
        .string()
        .describe("The topic to get a fact about (science, history, or nature)"),
    }),
  }
);

/**
 * Branching Chat Agent
 *
 * A simple agent that demonstrates conversation branching.
 * Users can edit previous messages or regenerate AI responses
 * to explore different conversation paths.
 */
export const agent = createAgent({
  model,
  tools: [calculate, getFact],
  checkpointer: new MemorySaver(),
  systemPrompt: `You are a helpful and curious assistant that loves exploring ideas.

When answering questions:
- Be concise but informative
- If asked about math, use the calculator tool
- If asked for interesting facts, use the get_fact tool
- Be creative and engaging in your responses

Since users can branch conversations and try different questions,
feel free to be playful and offer alternative angles they might explore.`,
});

