/**
 * WebSocket transport against the Python `langgraph-api` server.
 *
 * The SDK defaults to SSE+HTTP; passing `transport: "websocket"` (or
 * setting `streamProtocol: "v2-websocket"` on the client) routes every
 * command and event over a single full-duplex WebSocket on
 * `ws://<host>/v2/threads/{thread_id}`.
 *
 * This script verifies:
 *   - The WS route accepts `subscription.subscribe`,
 *     `subscription.unsubscribe`, `run.start`, and `agent.getTree` as
 *     in-band commands on the same socket.
 *   - Overlapping subscriptions on one session do NOT re-deliver the
 *     same event twice (verified by the `seq` stream being monotonic
 *     with no repeats).
 *
 * Prereq:
 *   cd langgraph-api/api && make start
 *
 * Run:
 *   npx tsx src/api/websocket.ts
 */

import { Client } from "@langchain/langgraph-sdk";

import { apiUrl, nsPrefix, requireServer } from "./_shared.js";

interface TreeNode {
  namespace: string[];
  status: string;
  graph_name?: string;
  children?: TreeNode[];
}

async function main() {
  const url = apiUrl();
  await requireServer(url);

  const client = new Client({ apiUrl: url });
  const thread = client.threads.stream({
    assistantId: "agent_echo_stream",
    transport: "websocket",
  });

  // Two overlapping subscriptions — a broad "values + messages + lifecycle"
  // sub and a narrower "messages" sub. The session should dedupe so
  // every event is delivered once even though both filters match any
  // messages frame.
  const broad = await thread.subscribe({
    channels: ["lifecycle", "values", "messages"],
  });
  const narrow = await thread.subscribe({ channels: ["messages"] });
  console.log(
    `--- broad sub ${broad.subscriptionId}, narrow sub ${narrow.subscriptionId} ---`
  );

  await thread.run.start({
    input: {
      messages: [{ role: "user", content: "ws-smoke-test" }],
    },
  });

  console.log("--- Events via WebSocket ---\n");
  const seen: number[] = [];
  for await (const event of broad) {
    if (event.seq != null) seen.push(event.seq);
    const prefix = nsPrefix(event.params.namespace);
    console.log(`  seq=${event.seq} ${prefix}${event.method}`);
  }

  // Verify seq is strictly increasing (monotonic + no repeats). If any
  // event appeared twice (e.g. because both subs matched and the server
  // failed to dedupe), this would drop.
  const monotonic = seen.every(
    (value, index) => index === 0 || value > (seen[index - 1] ?? -Infinity)
  );
  console.log(
    `\n--- seq strictly increasing: ${monotonic ? "✓" : "✗"} (${seen.length} events) ---`
  );

  // Verify agent.getTree returns after the run is complete.
  const tree = (await thread.agent.getTree()) as { tree: TreeNode };
  console.log(
    `--- agent.getTree: root graph "${tree.tree.graph_name}", status=${tree.tree.status} ---`
  );

  // Unsubscribe explicitly to exercise the unsubscribe command path
  // (the session is torn down below anyway, but the command should
  // still return success).
  await narrow.unsubscribe();
  console.log("--- narrow subscription unsubscribed ---");

  await thread.close();
}

await main();
