/**
 * Custom StreamTransformer — extend streamV2() with domain-specific projections.
 *
 * This example shows two transformer patterns:
 *
 *   1. Final values — promises resolved once when the run ends (e.g. total
 *      token count).  Consumers `await` them after the stream is done.
 *
 *   2. Streaming updates — an AsyncIterable backed by an EventLog that
 *      yields incremental items as events arrive.  Consumers iterate them
 *      concurrently with the main event stream.
 *
 * Both patterns use the same StreamTransformer interface.  The difference is
 * what you put in the projection returned from `init()`:
 *   - A `Promise` for final values
 *   - An `AsyncIterable` (via `EventLog`) for streaming updates
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/custom-reducer.ts
 */

import type {
  ProtocolEvent,
  StreamTransformer,
  MessagesEventData,
  ToolsEventData,
} from "@langchain/langgraph";
import { EventLog } from "@langchain/langgraph";
import { graph } from "./agents/simple-tool-graph.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";

/**
 * Pattern 1: Final values — resolved once at the end of the run.
 */
const statsTransformer = (): StreamTransformer<{
  toolCallCount: Promise<number>;
  totalTokens: Promise<number>;
}> => {
  let tools = 0;
  let tokens = 0;

  let resolveTools: (n: number) => void;
  let resolveTokens: (n: number) => void;
  const toolCallCount = new Promise<number>((r) => {
    resolveTools = r;
  });
  const totalTokens = new Promise<number>((r) => {
    resolveTokens = r;
  });

  return {
    init: () => ({ toolCallCount, totalTokens }),

    process(event: ProtocolEvent): boolean {
      if (event.method === "tools") {
        const data = event.params.data as ToolsEventData;
        if (data.event === "tool-started") tools += 1;
      }

      if (event.method === "messages") {
        const data = event.params.data as MessagesEventData;
        if (data.event === "message-finish" && data.usage) {
          tokens +=
            (data.usage.inputTokens ?? 0) + (data.usage.outputTokens ?? 0);
        }
      }

      return true;
    },

    finalize() {
      resolveTools(tools);
      resolveTokens(tokens);
    },

    fail() {
      resolveTools(tools);
      resolveTokens(tokens);
    },
  };
};

/**
 * Pattern 2: Streaming updates — yields tool activity as it happens.
 *
 * The EventLog acts as the async buffer: the transformer pushes items into it
 * during `process()`, and the consumer iterates them in a concurrent
 * `for await` loop.  The log is closed in `finalize()` / `fail()` so the
 * iterator ends when the run ends.
 */
const toolActivityTransformer = (): StreamTransformer<{
  toolActivity: AsyncIterable<{ name: string; status: string }>;
}> => {
  const log = new EventLog<{ name: string; status: string }>();

  return {
    init: () => ({ toolActivity: log.toAsyncIterable() }),

    process(event: ProtocolEvent): boolean {
      if (event.method !== "tools") return true;

      const data = event.params.data as ToolsEventData;
      if (data.event === "tool-started") {
        log.push({ name: data.toolName, status: "started" });
      } else if (data.event === "tool-finished") {
        log.push({ name: data.toolCallId, status: "finished" });
      } else if (data.event === "tool-error") {
        log.push({ name: data.toolCallId, status: "error" });
      }
      return true;
    },

    finalize: () => log.close(),
    fail: (err) => log.fail(err),
  };
};

const run = await graph.streamV2(
  {
    messages: [
      {
        role: "user",
        content:
          "What is the square root of 144? Then search for who discovered it.",
      },
    ],
  },
  { transformers: [statsTransformer, toolActivityTransformer] }
);

console.log(`${BOLD}--- Parallel consumers ---${RESET}\n`);

await Promise.all([
  // Consumer 1: stream text from run.messages (built-in projection)
  (async () => {
    let msgIndex = 0;
    for await (const msg of run.messages) {
      msgIndex += 1;
      const text = await msg.text;
      if (text.length > 0) {
        console.log(`${CYAN}[message #${msgIndex}]${RESET} ${text}`);
      } else {
        console.log(`${CYAN}[message #${msgIndex}]${RESET} ${DIM}(tool call)${RESET}`);
      }
    }
  })(),

  // Consumer 2: stream tool activity (custom transformer projection)
  (async () => {
    for await (const activity of run.extensions.toolActivity) {
      const icon = activity.status === "started" ? YELLOW : GREEN;
      console.log(`${icon}[tool]${RESET} ${activity.name} ${DIM}→ ${activity.status}${RESET}`);
    }
  })(),
]);

console.log(`\n${BOLD}--- Final stats (from statsTransformer) ---${RESET}`);
console.log(`  Tool calls:   ${await run.extensions.toolCallCount}`);
console.log(`  Total tokens: ${await run.extensions.totalTokens}`);
