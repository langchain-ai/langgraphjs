/**
 * Subgraph observation — recursive subgraph tree walking.
 *
 * The research pipeline has two sequential subgraphs (researcher → analyst).
 * This example demonstrates two complementary approaches:
 *
 *   1. Subgraph-scoped messages — discover subgraphs via run.subgraphs,
 *      then consume each subgraph's messages independently.
 *
 *   2. Root-level messages — consume all messages from the root run
 *      without caring about subgraph boundaries (simpler, flat view).
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/subgraphs.ts
 */

import type { SubgraphRunStream } from "@langchain/langgraph";
import { graph } from "./agents/research-pipeline.js";

const input = {
  messages: [
    {
      role: "user" as const,
      content: "Research TypeScript 5.8 features and identify risks.",
    },
  ],
};

/**
 * Approach 1: Hierarchical observation.
 *
 * Discover subgraphs as they spawn and consume each one's messages
 * independently. This is the right model for rendering each subgraph
 * in its own panel/card/section.
 */
async function hierarchical() {
  console.log("=== Approach 1: Hierarchical (per-subgraph messages) ===\n");

  const run = await graph.stream_experimental(input);

  async function observe(sub: SubgraphRunStream, depth = 1) {
    const indent = "  ".repeat(depth);
    console.log(`${indent}[${sub.name}] spawned`);

    const children: Promise<void>[] = [];

    await Promise.all([
      (async () => {
        for await (const msg of sub.messages) {
          const text = await msg.text;
          if (text.length > 0) {
            const preview =
              text.length > 80 ? `${text.slice(0, 77)}...` : text;
            console.log(`${indent}  message: ${preview}`);
          }
        }
      })(),
      (async () => {
        for await (const child of sub.subgraphs) {
          children.push(observe(child, depth + 1));
        }
      })(),
    ]);

    await Promise.all(children);
    console.log(`${indent}[${sub.name}] completed`);
  }

  const tasks: Promise<void>[] = [];
  for await (const sub of run.subgraphs) {
    tasks.push(observe(sub));
  }
  await Promise.all(tasks);

  const state = await run.output;
  console.log(`\nDone (${(state?.messages as unknown[])?.length ?? 0} total messages)\n`);
}

/**
 * Approach 2: Flat observation.
 *
 * Consume all messages from the root run.  This is simpler and works
 * well when you just want to render a single message feed regardless
 * of which subgraph produced each message.
 */
export async function flat() {
  console.log("=== Approach 2: Flat (all messages from root) ===\n");

  const run = await graph.stream_experimental(input);

  let count = 0;
  for await (const msg of run.messages) {
    count += 1;
    const text = await msg.text;
    if (text.length > 0) {
      const preview = text.length > 100 ? `${text.slice(0, 97)}...` : text;
      const node = msg.node ?? "?";
      console.log(`  [msg #${count}, node=${node}] ${preview}`);
    }
  }

  const state = await run.output;
  console.log(`\nDone (${count} messages streamed, ${(state?.messages as unknown[])?.length ?? 0} in final state)\n`);
}

// Run the hierarchical approach by default; uncomment flat() instead to compare.
await hierarchical();
// await flat();
