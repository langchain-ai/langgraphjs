/**
 * Channel-selection isolation test against the Python
 * `langgraph-api` server.
 *
 * Opens one SSE subscription per supported channel (6 total) against a
 * single run of ``agent_echo_stream`` and verifies:
 *
 *   1. Each subscription receives *only* events for its requested
 *      channel. No cross-channel leakage.
 *   2. Events that the server produces regardless of channel (e.g.
 *      the subgraph ``lifecycle.started`` event) only reach the
 *      ``lifecycle`` subscription.
 *   3. Every subscription terminates cleanly on the root terminal
 *      lifecycle (or hits the idle-silence timeout for channels that
 *      the fixture graph doesn't emit on — ``input``).
 *
 * The channels exercised:
 *   lifecycle, values, updates, messages, input, tasks.
 *
 * Notes:
 *   - ``tools`` and ``custom`` are skipped here because the fixture
 *     doesn't emit on them; ``tools.ts`` covers tools-channel
 *     isolation separately.
 *   - ``debug`` and ``checkpoints`` were removed from the protocol
 *     channel set in ``@langchain/protocol@0.0.10`` (upstream commit
 *     f39ff38). They're rejected by the server's subscribe validator
 *     now; ``unsupported-channel.ts`` covers that path.
 *   - Each SSE subscription consumes one slot from the undici
 *     per-origin connection pool (default 10). Keeping the matrix at
 *     6 leaves headroom for the ``POST /commands`` call that drives
 *     the run.
 *
 * Prereq:
 *   cd langgraph-api/api && make start
 *
 * Run:
 *   npx tsx src/api/channels.ts
 */

import { Client } from "@langchain/langgraph-sdk";

import { apiUrl, requireServer } from "./_shared.js";

type Channel =
  | "lifecycle"
  | "values"
  | "updates"
  | "messages"
  | "input"
  | "tasks";

const CHANNELS: readonly Channel[] = [
  "lifecycle",
  "values",
  "updates",
  "messages",
  "tasks",
  "input",
];

interface CollectedEvent {
  method: string;
  namespace: readonly string[];
  data: unknown;
}

async function openAndDrain(
  handle: Awaited<ReturnType<ReturnType<Client["threads"]["stream"]>["subscribe"]>>,
  silenceMs: number
): Promise<CollectedEvent[]> {
  const collected: CollectedEvent[] = [];
  const TERMINAL = new Set(["completed", "failed", "interrupted"]);
  return new Promise<CollectedEvent[]>((resolve) => {
    // Start the idle timer BEFORE consuming so channels that never
    // receive an event (e.g. ``input`` when the fixture doesn't
    // interrupt) still terminate after ``silenceMs``.
    let idle: NodeJS.Timeout | undefined;
    const finish = () => {
      if (idle) clearTimeout(idle);
      handle.close();
      resolve(collected);
    };
    const resetIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(finish, silenceMs);
    };
    resetIdle();
    (async () => {
      for await (const raw of handle) {
        resetIdle();
        const ev = raw as {
          method: string;
          params: { namespace: readonly string[]; data: unknown };
        };
        collected.push({
          method: ev.method,
          namespace: ev.params.namespace,
          data: ev.params.data,
        });
        const data = ev.params.data as { event?: string } | undefined;
        if (
          ev.method === "lifecycle" &&
          ev.params.namespace.length === 0 &&
          data?.event != null &&
          TERMINAL.has(data.event)
        ) {
          finish();
          return;
        }
      }
      finish();
    })().catch(() => finish());
  });
}

async function main() {
  const url = apiUrl();
  await requireServer(url);

  const thread = new Client({ apiUrl: url }).threads.stream({
    assistantId: "agent_echo_stream",
  });

  // Open each subscription sequentially (each ``thread.subscribe`` is
  // ``await``-ed before moving on) so 8 concurrent ``POST /events``
  // requests don't race undici's connection pool before the run even
  // starts. Drains run in parallel after every handle is established.
  const drains: Record<Channel, Promise<CollectedEvent[]>> = {} as Record<
    Channel,
    Promise<CollectedEvent[]>
  >;
  for (const channel of CHANNELS) {
    const handle = await thread.subscribe({ channels: [channel] });
    // 3s silence window — the run takes ~700ms queue + execution, so
    // we want to wait well past that for empty-channel subs (the
    // ``input`` sub never receives an event on this graph) while
    // still keeping the overall test snappy. Subs that DO get events
    // terminate early on the root terminal lifecycle.
    drains[channel] = openAndDrain(handle, 3000);
  }
  console.log(
    `--- ${CHANNELS.length} subscriptions opened, driving agent_echo_stream ---\n`
  );
  await thread.run.start({
    input: {
      messages: [{ role: "user", content: "channel isolation test" }],
    },
  });

  const results: Record<Channel, CollectedEvent[]> = {} as Record<
    Channel,
    CollectedEvent[]
  >;
  for (const channel of CHANNELS) {
    results[channel] = await drains[channel];
  }
  await thread.close();

  // --- Per-channel summary ---
  console.log("Events delivered per subscription:\n");
  console.log(
    `  ${"channel".padEnd(14)} ${"count".padStart(5)}  methods observed`
  );
  for (const channel of CHANNELS) {
    const events = results[channel];
    const methods = new Set(events.map((e) => e.method));
    console.log(
      `  ${channel.padEnd(14)} ${String(events.length).padStart(5)}  ${
        [...methods].sort().join(", ") || "(none)"
      }`
    );
  }
  console.log();

  // --- Isolation assertions ---
  // For each channel subscription, every event's method must map
  // back to that channel. ``input.requested`` events map to the
  // ``input`` channel (that mapping happens in the server's
  // ``_matches_subscription``).
  const INPUT_ALIAS = "input.requested";
  let leaks = 0;
  for (const channel of CHANNELS) {
    for (const ev of results[channel]) {
      const expected = channel === "input" ? [INPUT_ALIAS] : [channel];
      if (!expected.includes(ev.method)) {
        leaks += 1;
        console.log(
          `  leak: channel=${channel} received method="${ev.method}" ns=${JSON.stringify(ev.namespace)}`
        );
      }
    }
  }
  console.log(
    `assertion — zero cross-channel leaks across ${CHANNELS.length} subs: ${
      leaks === 0 ? "✓" : `✗ (${leaks} events leaked)`
    }`
  );

  // Channels the agent_echo_stream fixture is expected to emit on.
  const NONEMPTY: readonly Channel[] = [
    "lifecycle",
    "values",
    "updates",
    "messages",
    "tasks",
  ];
  const EMPTY: readonly Channel[] = ["input"];
  for (const ch of NONEMPTY) {
    console.log(
      `assertion — ${ch.padEnd(11)} sub saw at least one event: ${
        results[ch].length > 0 ? "✓" : `✗ (got 0)`
      }`
    );
  }
  for (const ch of EMPTY) {
    console.log(
      `assertion — ${ch.padEnd(11)} sub stayed empty (graph doesn't emit): ${
        results[ch].length === 0 ? "✓" : `✗ (got ${results[ch].length})`
      }`
    );
  }

  // Sanity: the lifecycle sub must have seen the root ``running`` and
  // ``completed`` events — that's what ended its drain.
  const lifecycleEvents = results.lifecycle;
  const rootLifecycle = lifecycleEvents.filter(
    (e) => e.namespace.length === 0
  );
  const rootEvents = rootLifecycle.map(
    (e) => (e.data as { event?: string }).event
  );
  const hasRunning = rootEvents.includes("running");
  const hasCompleted = rootEvents.includes("completed");
  console.log(
    `assertion — lifecycle sub saw root running: ${hasRunning ? "✓" : "✗"}`
  );
  console.log(
    `assertion — lifecycle sub saw root completed: ${hasCompleted ? "✓" : "✗"}`
  );
}

await main();
