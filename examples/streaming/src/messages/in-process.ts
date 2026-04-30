/**
 * Streaming messages — consume text tokens as they arrive.
 *
 * Demonstrates the .messages projection on GraphRunStream. Each yielded
 * ChatModelStream represents one AI message lifecycle. The .text getter
 * is both an AsyncIterable (for streaming) and a PromiseLike (for the
 * full text).
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/messages/in-process.ts
 */

import { graph } from "../agents/simple-tool-graph.js";

const run = await graph.streamEvents(
  {
    messages: [
      {
        role: "user",
        content:
          "Search the web for the current population of Tokyo, then calculate what 1% of that number is.",
      },
    ],
  },
  { version: "v3" }
);

console.log("--- Streaming messages (in-process) ---");
for await (const message of run.messages) {
  process.stdout.write("\n  reasoning: ");
  for await (const reasoning of message.reasoning) {
    process.stdout.write(reasoning);
  }

  process.stdout.write("\n  text: ");
  for await (const token of message.text) {
    process.stdout.write(token);
  }

  const output = await message.output;
  process.stdout.write(
    `\n  content blocks: ${output.content.length}`
  );

  const usage = await message.usage;
  if (usage) {
    process.stdout.write(
      `\n  tokens: ${usage.input_tokens ?? 0} in, ${usage.output_tokens ?? 0} out`
    );
  }

  process.stdout.write("\n\n");
}

console.log("--- Final output ---");
const state = await run.output;
const last = state?.messages?.at(-1);
console.log(last);
