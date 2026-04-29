/**
 * Subgraph observation in-process — discover subgraphs and stream their
 * messages directly from the compiled graph.
 *
 * Mirrors the remote `thread.subgraphs` iteration using `run.subgraphs`.
 * For each discovered subgraph, text deltas are rendered token-by-token
 * from `sub.messages`.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/subgraphs/in-process.ts
 */

import { graph } from "../agents/research-pipeline.js";

async function main() {
  const run = await graph.streamEvents(
    {
      messages: [
        {
          role: "user" as const,
          content: "Research TypeScript 5.8 features and identify risks.",
        },
      ],
    },
    { version: "v3" }
  );

  const workers: Promise<void>[] = [];

  for await (const sub of run.subgraphs) {
    console.log(
      `\n--- Subgraph: ${sub.name} [${sub.path.join("/")}] ---`
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

  console.log("\nDone.");
}

await main();
