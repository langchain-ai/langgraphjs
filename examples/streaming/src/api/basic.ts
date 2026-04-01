/**
 * Basic end-to-end verification against the Python `langgraph-api` server.
 *
 * Starts a run on `agent_echo_stream` (a tiny test-fixture graph bundled
 * with the Python API) and streams every protocol event across the
 * core channels until the run completes.
 *
 * This exercises:
 *   - `POST /v2/threads/{thread_id}/commands` for `run.start`
 *   - `POST /v2/threads/{thread_id}/events` SSE stream
 *   - CDDL envelope shape (`type`, `seq`, `event_id`, `method`, `params`)
 *   - Lifecycle events (`running`, `completed`)
 *   - Messages content-block lifecycle (`message-start` →
 *     `content-block-*` → `message-finish`)
 *
 * Prereq:
 *   cd langgraph-api/api && make start
 *
 * Run:
 *   npx tsx src/api/basic.ts
 */

import { Client } from "@langchain/langgraph-sdk";

import { apiUrl, nsPrefix, requireServer, short } from "./_shared.js";

async function main() {
  const url = apiUrl();
  await requireServer(url);
  console.log(`--- Connected to langgraph-api at ${url} ---\n`);

  const client = new Client({ apiUrl: url });
  const thread = client.threads.stream({ assistantId: "agent_echo_stream" });

  // Subscribe to the full channel set so we see values, messages, lifecycle,
  // tools (if any), updates, custom, input, debug, tasks, checkpoints.
  const events = await thread.subscribe({
    channels: [
      "lifecycle",
      "values",
      "updates",
      "messages",
      "tools",
      "custom",
      "input",
    ],
  });

  await thread.run.start({
    input: {
      messages: [{ role: "user", content: "Hello from the JS SDK." }],
    },
  });

  console.log("--- Protocol events ---\n");

  let count = 0;
  for await (const event of events) {
    count += 1;
    const prefix = nsPrefix(event.params.namespace);
    const data = event.params.data
    console.log(
      `#${String(event.seq).padStart(3, "0")} ${prefix}${event.method.padEnd(10)} ` +
        `${short(data)}`
    );
  }

  console.log(`\n--- Run complete (${count} events) ---`);
  const finalState = await thread.output as { messages?: { content?: unknown }[] };
  const lastMessage = finalState?.messages?.at(-1);
  if (lastMessage) {
    const content =
      typeof lastMessage.content === "string"
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);
    console.log(`Final assistant message: ${short(content, 200)}`);
  }

  await thread.close();
}

await main();
