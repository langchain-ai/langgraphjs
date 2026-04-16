/**
 * Track how many subagents are running vs completed without
 * subscribing to all channels.
 *
 * Demonstrates: subscribe("subagents") which only subscribes to
 * the tools + lifecycle channels. Each yielded SubagentHandle has
 * an `output` promise that resolves when the task tool finishes,
 * making it easy to track started/completed counts. Heavier channels
 * (messages, values) are never subscribed unless you explicitly call
 * `.subscribe()` on an individual SubagentHandle.
 *
 * Run against a running LangGraph server:
 *   npx tsx src/examples/subagent-status-tracker.ts
 */

import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:2024" });

const session = await client.stream.open({
  protocol_version: "0.3.0",
  target: { id: "deep-agent" },
});

const subagents = await session.subscribe("subagents");

await session.run.input({
  input: {
    messages: [
      {
        role: "user",
        content:
          "Write four poems: a haiku about mountains, a limerick about cats, a quatrain about rain, and a long poem about space",
      },
    ],
  },
});

let started = 0;
let completed = 0;
let failed = 0;

function printStatus() {
  const total = started + completed + failed;
  console.log(
    `  [${total} subagent(s)] ` +
      `started: ${started}, ` +
      `completed: ${completed}, ` +
      `failed: ${failed}`
  );
}

for await (const subagent of subagents) {
  started += 1;
  console.log(`${subagent.name}: started (${subagent.callId})`);
  printStatus();

  subagent.output.then(
    () => {
      started -= 1;
      completed += 1;
      console.log(`${subagent.name}: completed (${subagent.callId})`);
      printStatus();
    },
    () => {
      started -= 1;
      failed += 1;
      console.log(`${subagent.name}: failed (${subagent.callId})`);
      printStatus();
    }
  );
}

console.log("\n=== Final ===");
console.log(
  `  started: ${started}, completed: ${completed}, failed: ${failed}`
);

await session.close();
console.log("\nDone.");
