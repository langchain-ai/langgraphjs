/**
 * Streaming messages remotely — consume text tokens as they arrive from a
 * LangGraph dev server via the SDK client.
 *
 * Mirrors the in-process `run.messages` iteration using
 * `thread.messages`. Each yielded `StreamingMessage` exposes `.text`
 * as both an `AsyncIterable<string>` (for token-by-token streaming)
 * and a `PromiseLike<string>` (for the full text).
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/messages/remote.ts
 */

import { Client } from "@langchain/langgraph-sdk";

import { startDevServer } from "../shared/dev-server.js";

async function main() {
  console.log("--- Starting dev server ---\n");
  const { url, stop } = await startDevServer({ silent: true });

  try {
    const client = new Client({ apiUrl: url });
    const thread = client.threads.stream({ assistantId: "simple-tool-graph" });
    await thread.run.start({
      input: {
        messages: [
          {
            role: "user",
            content:
              "Search the web for the current population of Tokyo, then calculate what 1% of that number is.",
          },
        ],
      },
    });

    console.log("--- Streaming messages (remote) ---");
    for await (const message of thread.messages) {
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
    const state = (await thread.output) as
      | { messages?: { content: unknown }[] }
      | undefined;
    const last = state?.messages?.at(-1);
    console.log(last);

    await thread.close();
  } finally {
    stop();
  }
}

await main();
