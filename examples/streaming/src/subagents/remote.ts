/**
 * Stream a single subagent's messages and tool calls from a deep agent
 * running on a LangGraph dev server.
 *
 * Demonstrates: `thread.subagents` → `sub.messages` + `sub.toolCalls`.
 * Remotely, the SDK exposes a typed `.subagents` getter (backed by the
 * `tools` + `lifecycle` channels) that yields `SubagentHandle`s.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/subagents/remote.ts
 */

import { Client } from "@langchain/langgraph-sdk";

import { startDevServer } from "../shared/dev-server.js";

console.log("--- Starting dev server ---\n");
const { url, stop } = await startDevServer({ silent: true });

try {
  const client = new Client({ apiUrl: url });

  const thread = client.threads.stream({ assistantId: "deep-agent" });

  await thread.run.start({
    input: {
      messages: [{ role: "user", content: "Write me a haiku about the sea" }],
    },
  });

  for await (const sub of thread.subagents) {
    console.log(`\n--- Subagent: ${sub.name} (call: ${sub.callId}) ---`);
    console.log(`Namespace: ${sub.namespace.join("/")}`);
    console.log(`Task: ${await sub.taskInput}`);

    void (async () => {
      for await (const msg of sub.messages) {
        const text = await msg.text;
        console.log(`  [message] ${sub.name}: ${text.slice(0, 100)}`);
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
  }

  const output = await thread.output as { messages: { text: string }[] };
  console.log(`\n--- Output ---`);
  console.log(output.messages.at(-1)?.text)

  await thread.close();
  console.log("\nDone.");
} finally {
  stop();
}
