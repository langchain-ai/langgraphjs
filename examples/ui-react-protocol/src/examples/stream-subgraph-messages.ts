/**
 * Stream messages from subgraphs discovered during a run.
 *
 * Demonstrates: subscribe("subgraphs") → sub.subscribe("messages")
 * with live text deltas rendered inline as they arrive.
 *
 * Subgraphs are discovered via lifecycle events. For each one we
 * create a namespace-scoped message subscription and stream text
 * token-by-token using the StreamingMessage `.text` async iterable.
 *
 * Run against a running LangGraph server:
 *   npx tsx src/examples/stream-subgraph-messages.ts
 */

import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:2024" });

const session = await client.stream.open({
  protocol_version: "0.3.0",
  target: { id: "stategraph" },
});

const subgraphs = await session.subscribe("subgraphs");

await session.run.input({
  input: {
    messages: [
      {
        role: "user",
        content:
          "List three benefits of using a streaming protocol for AI agents",
      },
    ],
  },
});

const workers: Promise<void>[] = [];

for await (const sub of subgraphs) {
  console.log(
    `\n--- Subgraph: ${sub.name} [${sub.namespace.join("/")}] ---`
  );

  const messages = await sub.subscribe("messages");

  workers.push(
    (async () => {
      for await (const msg of messages) {
        const label = msg.node ? `${sub.name}/${msg.node}` : sub.name;
        process.stdout.write(`\n  [${label}] `);

        for await (const delta of msg.text) {
          process.stdout.write(delta);
        }

        const usage = await msg.usage;
        if (usage?.input_tokens != null || usage?.output_tokens != null) {
          process.stdout.write(
            `\n  (tokens: ${usage.input_tokens} in / ${usage.output_tokens} out)`
          );
        }
        process.stdout.write("\n");
      }
    })()
  );

  const output = await sub.output;
  const summary = JSON.stringify(output ?? null).slice(0, 120);
  console.log(`\n--- Subgraph ${sub.name} completed: ${summary} ---`);
}

await Promise.all(workers);

await session.close();
console.log("\nDone.");
