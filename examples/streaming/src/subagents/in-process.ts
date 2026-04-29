/**
 * Stream subagent messages and tool calls in-process.
 *
 * `createDeepAgent` returns a `DeepAgentRunStream` whose `.subagents`
 * projection is populated by a native `SubagentTransformer`. Unlike
 * `run.subgraphs` (which also yields internal subgraphs like the
 * coordinator's `model_request` LLM call), `.subagents` only yields
 * real subagent invocations — one `SubagentRunStream` per `task` tool
 * call. Each `SubagentRunStream` exposes:
 *
 *   - `name`          — the subagent type (e.g. "haiku-drafter")
 *   - `taskInput`     — the prompt passed to the `task` tool
 *   - `messages`      — the subagent's ChatModelStream messages
 *   - `toolCalls`     — typed ToolCallStream instances scoped to it
 *   - `output`        — the final state value
 *
 * Remote equivalent: `thread.subagents` — see `./remote.ts`, which is
 * backed by `SubagentDiscoveryHandle` in the SDK.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/subagents/in-process.ts
 */

import { agent } from "../agents/deep-agent.js";

const run = await agent.streamEvents(
  {
    messages: [{ role: "user", content: "Write me a haiku about the sea" }],
  },
  { version: "v3", configurable: { thread_id: `subagents-${Date.now()}` } }
);

const watchers: Promise<void>[] = [];

for await (const sub of run.subagents) {
  console.log(`\n--- Subagent: ${sub.name} ---`);
  console.log(`Task: ${await sub.taskInput}`);

  watchers.push(
    (async () => {
      void (async () => {
        for await (const msg of sub.messages) {
          const text = await msg.text;
          if (text.length > 0) {
            console.log(`  [message] ${sub.name}: ${text.slice(0, 100)}`);
          }
        }
      })();

      void (async () => {
        for await (const tc of sub.toolCalls) {
          console.log(
            `  [tool] ${tc.name}(${JSON.stringify(tc.input).slice(0, 80)})`
          );
          const status = await tc.status;
          console.log(`  [tool] ${tc.name} → ${status}`);
        }
      })();
    })()
  );
}

await Promise.all(watchers);

const output = await run.output;
console.log(`\n--- Output ---`);
console.log(output.messages.at(-1)?.text)

console.log("\nDone.");
