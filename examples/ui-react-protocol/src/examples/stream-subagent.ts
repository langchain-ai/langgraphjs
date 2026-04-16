/**
 * Stream a single subagent's messages and tool calls from a deep agent.
 *
 * Demonstrates: subscribe("subagents") → sub.subscribe("messages") + sub.subscribe("toolCalls")
 *
 * Run against a running LangGraph server:
 *   npx tsx src/examples/stream-subagent.ts
 */

import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:2024" });

const session = await client.stream.open({
  protocol_version: "0.3.0",
  target: { id: "deep-agent" },
});

const subagents = await session.subscribe("subagents");
await session.run.input({
  input: {
    messages: [{ role: "user", content: "Write me a haiku about the sea" }],
  },
});

for await (const sub of subagents) {
  console.log(`\n--- Subagent: ${sub.name} (call: ${sub.callId}) ---`);
  console.log(`Namespace: ${sub.namespace.join("/")}`);
  console.log(`Task: ${await sub.taskInput}`);

  const [messages, toolCalls] = await Promise.all([
    sub.subscribe("messages"),
    sub.subscribe("toolCalls"),
  ]);

  // Collect messages and tool calls until the subagent finishes.
  // We fire these as background tasks because the SSE connection
  // stays open after the subagent completes — the loops won't
  // terminate on their own until session.close().
  void (async () => {
    for await (const msg of messages) {
      const text = await msg.text;
      console.log(`  [message] ${sub.name}: ${text.slice(0, 100)}`);
    }
  })();
  void (async () => {
    for await (const tc of toolCalls) {
      console.log(`  [tool] ${tc.name}(${JSON.stringify(tc.input).slice(0, 80)})`);
      const status = await tc.status;
      console.log(`  [tool] ${tc.name} → ${status}`);
    }
  })();

  const output = await sub.output;
  console.log(`  [output] ${JSON.stringify(output).slice(0, 120)}...`);
  break;
}

await session.close();
console.log("\nDone.");
