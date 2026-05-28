/**
 * Parallel-projection stress for the Python `langgraph-api` server.
 *
 * One thread, one run, four concurrent SDK projections active at the
 * same time:
 *
 *   - `thread.values`       (state snapshots)
 *   - `thread.messages`     (content-block-lifecycle)
 *   - `thread.lifecycle`    (raw subscribe on "lifecycle")
 *   - extension `tools`     (raw subscribe on "tools", sanity-bound
 *                           even though agent_echo_stream doesn't
 *                           emit any — we assert no events leak)
 *
 * The SDK opens one SSE stream per projection with overlapping
 * channel filters. This script verifies the server can fan the same
 * underlying run events out across multiple concurrent sessions
 * without cross-talk or starvation.
 *
 * What this exercises server-side:
 *
 *   - `_ensure_run_session`: every HTTP SSE request spins up its own
 *     `RunProtocolSession` bound to the same run. Each consumes its
 *     own `Runs.Stream` queue; each maintains its own `seq` counter.
 *   - `_matches_subscription` channel filtering: events flowing on
 *     one session's buffer only reach that session's subscribers
 *     (no cross-session leakage).
 *   - `_emit_input_requested_events` + terminal-lifecycle latching
 *     on a session that has *no* interrupt (sanity that we don't
 *     regress non-interrupt runs).
 *
 * Prereq:
 *   cd langgraph-api/api && make start
 *
 * Run:
 *   npx tsx src/api/parallel-subs.ts
 */

import { Client } from "@langchain/langgraph-sdk";

import { apiUrl, requireServer } from "./_shared.js";

async function main() {
  const url = apiUrl();
  await requireServer(url);

  const thread = new Client({ apiUrl: url }).threads.stream({
    assistantId: "agent_echo_stream",
  });

  // Raw lifecycle subscription — opens its own SSE stream.
  const lifecycleSub = await thread.subscribe({ channels: ["lifecycle"] });
  const lifecycleEvents: Array<{ seq?: number; event: string; ns: string }> = [];
  const lifecycleDrain = (async () => {
    for await (const raw of lifecycleSub) {
      const e = raw as {
        seq?: number;
        params: {
          namespace: readonly string[];
          data: { event?: string };
        };
      };
      lifecycleEvents.push({
        seq: e.seq,
        event: e.params.data.event ?? "(unknown)",
        ns: e.params.namespace.join("/") || "(root)",
      });
      if (
        e.params.namespace.length === 0 &&
        ["completed", "failed", "interrupted"].includes(
          e.params.data.event ?? ""
        )
      ) {
        break;
      }
    }
  })();

  // Raw tools subscription — won't receive any event for this graph.
  const toolsSub = await thread.subscribe({ channels: ["tools"] });
  const toolsEvents: Array<unknown> = [];
  const toolsDrain = (async () => {
    for await (const e of toolsSub) toolsEvents.push(e);
  })();

  // Values + messages via the SDK's assembled projections.
  const valuesIter = thread.values;
  const messagesIter = thread.messages;

  const valuesCount = { total: 0 };
  const valuesDrain = (async () => {
    for await (const _ of valuesIter) valuesCount.total += 1;
  })();

  const assembledMessages: Array<{ node?: string; text: string }> = [];
  const messagesDrain = (async () => {
    for await (const msg of messagesIter) {
      const text = await msg.text;
      assembledMessages.push({ node: msg.node, text });
    }
  })();

  // Kick off the run. `run.start` does NOT await the server's
  // completion — the SDK returns once the command-reply `success` lands.
  console.log("--- Driving agent_echo_stream with 4 parallel projections ---\n");
  await thread.run.start({
    input: {
      messages: [
        {
          role: "user",
          content: "parallel subscribe stress test",
        },
      ],
    },
  });

  await Promise.all([lifecycleDrain, messagesDrain, valuesDrain]);
  toolsSub.close();
  await toolsDrain;
  await thread.close();

  console.log("lifecycle sub:");
  for (const ev of lifecycleEvents) {
    console.log(`  seq=${ev.seq ?? "?"} ns=${ev.ns.padEnd(12)} event=${ev.event}`);
  }
  console.log(`values sub: ${valuesCount.total} snapshot(s)`);
  console.log(`messages sub: ${assembledMessages.length} assembled message(s)`);
  for (const m of assembledMessages) {
    console.log(`  node=${m.node} text=${JSON.stringify(m.text)}`);
  }
  console.log(`tools sub: ${toolsEvents.length} event(s)`);

  console.log();
  const hasRunning = lifecycleEvents.some((e) => e.event === "running");
  const hasCompleted = lifecycleEvents.some(
    (e) => e.event === "completed" && e.ns === "(root)"
  );
  console.log(
    `assertion — lifecycle sub saw root "running": ${hasRunning ? "✓" : "✗"}`
  );
  console.log(
    `assertion — lifecycle sub saw root "completed": ${hasCompleted ? "✓" : "✗"}`
  );
  console.log(
    `assertion — values sub drained at least one snapshot: ${
      valuesCount.total > 0 ? "✓" : "✗"
    }`
  );
  console.log(
    `assertion — messages sub assembled exactly one AI message: ${
      assembledMessages.length === 1 ? "✓" : `✗ (got ${assembledMessages.length})`
    }`
  );
  const assembled = assembledMessages[0];
  const echoMatches =
    assembled != null &&
    assembled.text === "parallel subscribe stress test";
  console.log(
    `assertion — assembled message text matches the input: ${
      echoMatches ? "✓" : `✗ (got ${JSON.stringify(assembled?.text)})`
    }`
  );
  console.log(
    `assertion — tools sub stayed empty (no tool nodes in this graph): ${
      toolsEvents.length === 0 ? "✓" : `✗ (got ${toolsEvents.length})`
    }`
  );
}

await main();
