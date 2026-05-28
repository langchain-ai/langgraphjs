/**
 * Multiple runs on a single thread with the default ``enqueue``
 * multitask strategy.
 *
 * Fires three ``run.start`` commands back-to-back on the same thread.
 * The protocol service creates one run per command; the worker queue
 * serializes them (``multitask_strategy: "enqueue"`` is hardcoded in
 * ``ThreadRunManager._create_or_resume_run``). Each run produces its
 * own ``lifecycle.running`` → ... → ``lifecycle.completed`` sequence.
 *
 * Three distinct run ids come back. Cumulative thread state (via REST
 * ``/threads/{tid}/state``) reflects all three: 3 user messages + 3
 * AI replies.
 *
 * NOTE ON CROSS-RUN SUBSCRIPTION GAP
 * ---------------------------------
 * A single SSE subscription on ``thread.subscribe`` currently binds to
 * the FIRST run only. When that run's terminal lifecycle fires, the
 * server-side session's source ends and the subscription stops
 * producing events — subsequent runs on the same thread need a fresh
 * subscription. That's why the per-subscription lifecycle check below
 * (``cross-run subscription carry-over``) is marked ``SKIPPED``;
 * making one SSE sub span multiple runs on a thread is tracked under
 * "Outstanding work" in ``docs/protocol-v2-implementation-plan.md``.
 *
 * Prereq:
 *   cd langgraph-api/api && make start
 *
 * Run:
 *   npx tsx src/api/multi-run.ts
 */

import { Client } from "@langchain/langgraph-sdk";

import { apiUrl, requireServer } from "./_shared.js";

async function main() {
  const url = apiUrl();
  await requireServer(url);

  const client = new Client({ apiUrl: url });
  const thread = client.threads.stream({
    assistantId: "agent_echo_stream",
  });

  const runIds: string[] = [];

  // Fire three runs sequentially. ``run.start`` returns as soon as the
  // command is acknowledged; the worker schedules them via enqueue.
  for (const body of ["first", "second", "third"]) {
    const result = (await thread.run.start({
      input: { messages: [{ role: "user", content: body }] },
    })) as { run_id?: string } | undefined;
    if (typeof result?.run_id !== "string") {
      throw new Error(`run.start did not return a run_id for "${body}"`);
    }
    runIds.push(result.run_id);
    console.log(`  fired "${body}" → run_id=${result.run_id}`);
    // Nudge the SDK's command dispatcher so run2/run3 don't collide
    // with run1's command-reply queue.
    await new Promise((r) => setTimeout(r, 20));
  }

  console.log(
    `\nassertion — three distinct run_ids: ${
      new Set(runIds).size === 3 ? "✓" : "✗"
    }`
  );

  // Wait for all enqueued runs to finish by polling REST.
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const res = await fetch(`${url}/threads/${thread.threadId}/runs`);
    const runs = (await res.json()) as Array<{ status: string; run_id: string }>;
    if (runs.length >= 3 && runs.every((r) => r.status === "success")) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  // Cross-run subscription carry-over — a known gap, skipped for now.
  console.log(
    `assertion — cross-run subscription carry-over on one SSE sub: SKIPPED ` +
      `(server binds one session per first run; tracked as outstanding work)`
  );

  // Cumulative thread state check via REST.
  const stateRes = await fetch(
    `${url}/threads/${thread.threadId}/state`
  );
  const state = (await stateRes.json()) as {
    values: { messages: Array<{ type: string; content: string }> };
  };
  const messages = state.values.messages;
  console.log(
    `\nfinal thread state: ${messages.length} message(s)`
  );
  for (const m of messages) {
    console.log(`  ${m.type.padEnd(8)} ${JSON.stringify(m.content)}`);
  }

  // agent_echo_stream: each user message becomes a user+ai pair in
  // the persisted state. Three runs → six messages.
  console.log(
    `assertion — cumulative state has 6 messages (3 user + 3 ai): ${
      messages.length === 6 ? "✓" : `✗ (got ${messages.length})`
    }`
  );
  const userContents = messages
    .filter((m) => m.type === "human")
    .map((m) => m.content);
  console.log(
    `assertion — user messages recorded in input order: ${
      JSON.stringify(userContents) ===
      JSON.stringify(["first", "second", "third"])
        ? "✓"
        : `✗ (got ${JSON.stringify(userContents)})`
    }`
  );

  await thread.close();
}

await main();
