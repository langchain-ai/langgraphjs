/**
 * Custom StreamTransformer — extend streamEvents(..., { version: "v3" }) with domain-specific projections.
 *
 * This example shows two transformer patterns, both defined in
 * `shared/custom-transformers.ts`:
 *
 *   1. `statsTransformer` — final values (total tool calls, total tokens)
 *      resolved once when the run ends.
 *
 *   2. `toolActivityTransformer` — streaming updates for every tool
 *      lifecycle event, yielded concurrently with the main event stream.
 *
 * Transformers can be supplied at compile time (see `agents/simple-tool-with-metrics.ts`,
 * which is what the remote example uses) or at call time via the
 * `{ transformers: [...] }` option — as done here.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/custom-transformer/in-process.ts
 */

import { graph } from "../agents/simple-tool-graph.js";
import {
  statsTransformer,
  toolActivityTransformer,
} from "../shared/custom-transformers.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";

const run = await graph.streamEvents(
  {
    messages: [
      {
        role: "user",
        content:
          "What is the square root of 144? Then search for who discovered it.",
      },
    ],
  },
  { version: "v3", transformers: [statsTransformer, toolActivityTransformer] }
);

console.log(`${BOLD}--- Parallel consumers ---${RESET}\n`);

await Promise.all([
  (async () => {
    let msgIndex = 0;
    for await (const msg of run.messages) {
      msgIndex += 1;
      const text = await msg.text;
      if (text.length > 0) {
        console.log(`${CYAN}[message #${msgIndex}]${RESET} ${text}`);
      } else {
        console.log(
          `${CYAN}[message #${msgIndex}]${RESET} ${DIM}(tool call)${RESET}`
        );
      }
    }
  })(),

  (async () => {
    for await (const activity of run.extensions.toolActivity) {
      const icon = activity.status === "started" ? YELLOW : GREEN;
      console.log(
        `${icon}[tool]${RESET} ${activity.name} ${DIM}→ ${activity.status}${RESET}`
      );
    }
  })(),
]);

console.log(`\n${BOLD}--- Final stats (from statsTransformer) ---${RESET}`);
console.log(`  Tool calls:   ${await run.extensions.toolCallCount}`);
console.log(`  Total tokens: ${await run.extensions.totalTokens}`);
