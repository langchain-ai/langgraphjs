/**
 * Parallel consumption — messages, values, and raw events concurrently.
 *
 * All projections on GraphRunStream read from the same underlying EventLog.
 * Multiple `for await` loops can run simultaneously without interfering.
 * This example uses the simple tool graph (direct model calls at root
 * level) so that `run.messages` captures the model output.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/parallel.ts
 */

import { graph } from "./agents/simple-tool-graph.js";

const run = await graph.stream_experimental({
  messages: [
    {
      role: "user",
      content:
        "Search the web for the population of Paris, then calculate 5% of that number.",
    },
  ],
});

console.log("--- Parallel consumption ---\n");

const [messageCount, valuesCount, eventCount] = await Promise.all([
  // Consumer 1: stream messages and count them
  (async () => {
    let count = 0;
    for await (const msg of run.messages) {
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

  // Consumer 2: count state snapshots
  (async () => {
    let count = 0;
    for await (const _snapshot of run.values) {
      count += 1;
    }
    return count;
  })(),

  // Consumer 3: count raw protocol events
  (async () => {
    let count = 0;
    for await (const _event of run) {
      count += 1;
    }
    return count;
  })(),
]);

const finalState = await run.output;

console.log("\n--- Summary ---");
console.log(`Messages streamed: ${messageCount}`);
console.log(`State snapshots: ${valuesCount}`);
console.log(`Total protocol events: ${eventCount}`);
console.log(
  `Final state messages: ${(finalState?.messages as unknown[] | undefined)?.length ?? 0}`
);
