/**
 * Custom StreamTransformer remotely — consume transformer projections from
 * a LangGraph dev server.
 *
 * When a graph is compiled with `transformers: [...]` (see
 * `agents/simple-tool-with-metrics.ts`), the API server detects
 * `graph.streamTransformers` and runs them server-side. Each transformer
 * projection is exposed to remote clients as a protocol `custom` channel
 * with name `custom:<name>`.
 *
 * On the client, `thread.extensions.<name>` returns a handle that is both:
 *
 *   - `AsyncIterable<T>` — iterate streaming updates as they arrive
 *   - `PromiseLike<T>`   — `await` resolves with the final value observed
 *     when the run terminates (works for both `StreamChannel`-based
 *     streaming transformers and final-value transformers that emit once
 *     on run end)
 *
 * Access order is flexible: a single shared `custom` subscription is
 * opened eagerly by `thread.run.start(...)` and buffers every custom
 * event for the run. Per-name handles created before, during, or after
 * the run are backfilled from that buffer and resolve correctly either
 * way — mirroring the in-process `run.extensions.<name>` shape (which
 * is just a Promise/iterable that can be awaited any time).
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/custom-transformer/remote.ts
 */

import type { InferExtensions } from "@langchain/langgraph";
import { Client } from "@langchain/langgraph-sdk";

import {
  statsTransformer,
  toolActivityTransformer,
} from "../shared/custom-transformers.js";
import { startDevServer } from "../shared/dev-server.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";

// Reuse the in-process projection shape derived from the same transformer
// factories the server compiled in. `ThreadStream<TExtensions>` unwraps
// `Promise<T>` / `StreamChannel<T>` / `AsyncIterable<T>` internally, so
// `thread.extensions.toolCallCount` is `ThreadExtension<number>` and
// `thread.extensions.toolActivity` is `ThreadExtension<{ name, status }>`
// — no duplicated type declarations.
type Extensions = InferExtensions<
  [typeof statsTransformer, typeof toolActivityTransformer]
>;

async function main() {
  console.log("--- Starting dev server ---\n");
  const { url, stop } = await startDevServer({ silent: true });

  try {
    const client = new Client({ apiUrl: url });

    const thread = client.threads.stream<Extensions>({
      assistantId: "simple-tool-with-metrics",
    });

    await thread.run.start({
      input: {
        messages: [
          {
            role: "user",
            content:
              "What is the square root of 144? Then search for who discovered it.",
          },
        ],
      },
    });

    console.log(`${BOLD}--- Parallel consumers ---${RESET}\n`);

    await Promise.all([
      (async () => {
        let msgIndex = 0;
        for await (const msg of thread.messages) {
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
        for await (const activity of thread.extensions.toolActivity) {
          const icon = activity.status === "started" ? YELLOW : GREEN;
          console.log(
            `${icon}[tool]${RESET} ${activity.name} ${DIM}→ ${activity.status}${RESET}`
          );
        }
      })(),
    ]);

    console.log(`\n${BOLD}--- Final stats (from statsTransformer) ---${RESET}`);
    console.log(`  Tool calls:   ${await thread.extensions.toolCallCount}`);
    console.log(`  Total tokens: ${await thread.extensions.totalTokens}`);

    await thread.close();
  } finally {
    stop();
  }
}

await main();
