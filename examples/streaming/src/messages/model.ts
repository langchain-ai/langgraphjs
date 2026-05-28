/**
 * Streaming messages directly from the chat model.
 *
 * Mirrors `messages/in-process.ts` and `messages/remote.ts`: consume reasoning,
 * consume text tokens, then read the finalized AIMessage via `.output`.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/messages/model.ts
 */

import { model } from "../agents/shared.js";

const stream = model.streamV2(
  "Search the web for the current population of Tokyo, then calculate what 1% of that number is."
);

console.log("--- Streaming messages (model) ---\n");
process.stdout.write(`[Message #1 from "model"] `);

process.stdout.write("\n  reasoning: ");
for await (const reasoning of stream.reasoning) {
  process.stdout.write(reasoning);
}

process.stdout.write("\n  text: ");
for await (const token of stream.text) {
  process.stdout.write(token);
}

console.log("\n\n--- Retrieving output ---");
const output = await stream.output;
process.stdout.write(
  `\n  content blocks: ${output.content.length}`
);

const usage = await stream.usage;
if (usage) {
  process.stdout.write(
    `\n  tokens: ${usage.input_tokens ?? 0} in, ${usage.output_tokens ?? 0} out`
  );
}

process.stdout.write("\n\n");
