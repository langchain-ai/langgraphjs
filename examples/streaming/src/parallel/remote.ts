/**
 * Parallel consumption remotely — messages, values, and raw events concurrently.
 *
 * All projections on `ThreadStream` read from independent subscriptions but
 * share a single underlying session. Multiple `for await` loops can run
 * simultaneously without interfering. Mirrors the in-process version using
 * the SDK client against a dev server.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/parallel/remote.ts
 */

import { Client } from "@langchain/langgraph-sdk";

import { startDevServer } from "../shared/dev-server.js";

async function main() {
  console.log("--- Starting dev server ---\n");
  const { url, stop } = await startDevServer({ silent: true });

  try {
    const client = new Client({ apiUrl: url });

    const thread = client.threads.stream({ assistantId: "simple-tool-graph" });

    // Open a raw event subscription before the run starts so we capture
    // every protocol event across the main channels.
    const rawEvents = await thread.subscribe({
      channels: ["messages", "tools", "values", "lifecycle"],
    });

    await thread.run.start({
      input: {
        messages: [
          {
            role: "user",
            content:
              "Search the web for the population of Paris, then calculate 5% of that number.",
          },
        ],
      },
    });

    console.log("--- Parallel consumption ---\n");

    const [messageCount, valuesCount, eventCount] = await Promise.all([
      (async () => {
        let count = 0;
        for await (const msg of thread.messages) {
          count += 1;
          const text = await msg.text;
          if (text.length > 0) {
            const preview = text.length > 60 ? `${text.slice(0, 57)}...` : text;
            console.log(`  [msg #${count}] ${preview}`);
          } else {
            console.log(`  [msg #${count}] (tool call)`);
          }
        }
        return count;
      })(),

      (async () => {
        let count = 0;
        for await (const _snapshot of thread.values) {
          count += 1;
        }
        return count;
      })(),

      (async () => {
        let count = 0;
        for await (const _event of rawEvents) {
          count += 1;
        }
        return count;
      })(),
    ]);

    const finalState = (await thread.values) as
      | { messages?: unknown[] }
      | undefined;

    console.log("\n--- Summary ---");
    console.log(`Messages streamed: ${messageCount}`);
    console.log(`State snapshots: ${valuesCount}`);
    console.log(`Total protocol events: ${eventCount}`);
    console.log(
      `Final state messages: ${finalState?.messages?.length ?? 0}`
    );

    await thread.close();
  } finally {
    stop();
  }
}

await main();
