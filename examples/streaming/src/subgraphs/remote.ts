/**
 * Subgraph observation remotely — discover subgraphs and stream their
 * messages via the SDK client.
 *
 * Mirrors the in-process `run.subgraphs` iteration using `thread.subgraphs`.
 * For each discovered subgraph, text deltas are rendered token-by-token
 * from `sub.messages`.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/subgraphs/remote.ts
 */

import { Client } from "@langchain/langgraph-sdk";

import { startDevServer } from "../shared/dev-server.js";

async function main() {
  console.log("--- Starting dev server ---\n");
  const { url, stop } = await startDevServer({ silent: true });

  try {
    const client = new Client({ apiUrl: url });

    const thread = client.threads.stream({
      assistantId: "research-pipeline",
    });

    await thread.run.start({
      input: {
        messages: [
          {
            role: "user",
            content: "Research TypeScript 5.8 features and identify risks.",
          },
        ],
      },
    });

    const workers: Promise<void>[] = [];

    for await (const sub of thread.subgraphs) {
      console.log(
        `\n--- Subgraph: ${sub.name} [${sub.namespace.join("/")}] ---`
      );

      workers.push(
        (async () => {
          for await (const msg of sub.messages) {
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

    await thread.close();
    console.log("\nDone.");
  } finally {
    stop();
  }
}

await main();
