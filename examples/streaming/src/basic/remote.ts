/**
 * Basic remote streaming — iterate protocol events from a LangGraph dev server.
 *
 * Spawns a dev server in-process, opens a `ThreadStream` against the
 * `simple-tool-graph` assistant, subscribes to all events on the default
 * channel set, and prints them until the run ends.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... npx tsx src/basic/remote.ts
 */

import { Client } from "@langchain/langgraph-sdk";

import { startDevServer } from "../shared/dev-server.js";

console.log("--- Starting dev server ---\n");
const { url, stop } = await startDevServer();

try {
  const client = new Client({ apiUrl: url });

  const thread = client.threads.stream({ assistantId: "simple-tool-graph" });

  // Subscribe to protocol events across all core channels.
  const events = await thread.subscribe({
    channels: ["messages", "tools", "values", "lifecycle"],
  });

  await thread.run.start({
    input: {
      messages: [{ role: "user", content: "What is 42 * 17?" }],
    },
  });

  console.log("--- All protocol events ---\n");

  for await (const event of events) {
    const ns = event.params.namespace;
    const prefix = ns.length > 0 ? `[${ns.join("/")}] ` : "";
    console.log(
      `${prefix}${event.method}`,
      JSON.stringify(event.params.data).slice(0, 120)
    );
  }

  const finalState = (await thread.output) as
    | { messages: { content: unknown }[] }
    | undefined;
  const lastMsg = finalState?.messages?.at(-1);
  console.log("\n--- Final answer ---");
  console.log(
    typeof lastMsg?.content === "string"
      ? lastMsg.content
      : JSON.stringify(lastMsg?.content)
  );

  await thread.close();
} finally {
  stop();
}
