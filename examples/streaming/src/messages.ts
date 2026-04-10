/**
 * Streaming messages — consume text tokens as they arrive.
 *
 * Demonstrates the .messages projection on GraphRunStream. Each yielded
 * ChatModelStream represents one AI message lifecycle. The .text getter
 * is both an AsyncIterable (for streaming) and a PromiseLike (for the
 * full text).
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/messages.ts
 */

import { graph } from "./agents/simple-tool-graph.js";

const run = await graph.streamV2({
  messages: [
    {
      role: "user",
      content: "Search the web for the current population of Tokyo, then calculate what 1% of that number is.",
    },
  ],
});

console.log("--- Streaming messages ---\n");

let messageIndex = 0;
for await (const message of run.messages) {
  messageIndex += 1;
  const node = message.node ?? "unknown";
  process.stdout.write(`[Message #${messageIndex} from "${node}"] `);

  // Stream text tokens as they arrive
  for await (const token of message.text) {
    process.stdout.write(token);
  }

  // Usage is available after message-finish
  const usage = await message.usage;
  if (usage) {
    process.stdout.write(
      `\n  (tokens: ${usage.inputTokens ?? 0} in, ${usage.outputTokens ?? 0} out)`
    );
  }

  process.stdout.write("\n\n");
}

console.log("--- Final output ---");
const state = await run.output;
const last = state?.messages?.at(-1);
console.log(
  typeof last?.content === "string" ? last.content : "(complex content)"
);
