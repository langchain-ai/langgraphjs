/**
 * Custom StreamReducer — extend streamV2() with domain-specific projections.
 *
 * Demonstrates passing a custom reducer factory via the `reducers` option.
 * The reducer counts tool calls and tracks total token usage, exposing
 * the results on `run.extensions`.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/custom-reducer.ts
 */

import type {
  ProtocolEvent,
  StreamReducer,
  MessagesEventData,
  ToolsEventData,
} from "@langchain/langgraph";
import { graph } from "./agents/simple-tool-graph.js";

/**
 * A reducer that counts tool invocations and tracks token usage.
 * Returned projections are merged into `run.extensions`.
 */
const statsReducer = (): StreamReducer<{
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
          tokens += (data.usage.inputTokens ?? 0) + (data.usage.outputTokens ?? 0);
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

const run = await graph.streamV2(
  {
    messages: [
      { role: "user", content: "What is the square root of 144? Then search for who discovered it." },
    ],
  },
  { reducers: [statsReducer] }
);

console.log("--- Streaming ---\n");

for await (const event of run) {
  if (event.method === "messages") {
    const data = event.params.data as MessagesEventData;
    if (data.event === "content-block-delta") {
      const cb = data.contentBlock as { type: string; text?: string };
      if (cb.type === "text" && cb.text) process.stdout.write(cb.text);
    }
    if (data.event === "message-finish") process.stdout.write("\n");
  }
  if (event.method === "tools") {
    const data = event.params.data as ToolsEventData;
    if (data.event === "tool-started") {
      console.log(`  [tool] ${data.toolName} started`);
    }
    if (data.event === "tool-finished") {
      console.log(`  [tool] finished`);
    }
  }
}

console.log("\n--- Stats (from custom reducer) ---");
console.log("Tool calls:", await run.extensions.toolCallCount);
console.log("Total tokens:", await run.extensions.totalTokens);
