/**
 * Mid-run subscribe + full-history replay against the Python
 * `langgraph-api` server.
 *
 * Simulates a "late-joining" client: the run starts; events accrue on
 * the server's run stream; only afterwards does a new SSE subscriber
 * connect. Because `_make_source_from_sub` passes ``last_event_id="0"``
 * to ``Runs.Stream.join``, the fresh session replays the run's full
 * recorded history before going live. Late-joiners should therefore
 * observe ALL of the events an early subscriber would have seen.
 *
 * The fixture is `agent` with ``sleep=1.5`` — call_model sleeps for
 * 1.5s before the first LLM response, guaranteeing we have a window
 * where the run is in-flight but has already emitted some events
 * (``values``, ``lifecycle.running``).
 *
 * Asserts:
 *   1. The early subscriber and the late subscriber see the SAME set
 *      of event_ids (full replay ⇒ no gaps for the late-comer).
 *   2. Both see the root terminal lifecycle.
 *   3. The late subscription opens AFTER at least one event has been
 *      emitted to the early subscription (proving "mid-run").
 *
 * Prereq:
 *   cd langgraph-api/api && make start
 *
 * Run:
 *   npx tsx src/api/hot-subscribe.ts
 */

import { Client, type SubscriptionHandle } from "@langchain/langgraph-sdk";
import type { Event } from "@langchain/protocol";

import { apiUrl, requireServer } from "./_shared.js";

async function collectUntilTerminal(
  handle: SubscriptionHandle
): Promise<Event[]> {
  const collected: Event[] = [];
  const TERMINAL = new Set(["completed", "failed", "interrupted"]);
  return new Promise<Event[]>((resolve) => {
    let idle: NodeJS.Timeout | undefined;
    const finish = () => {
      if (idle) clearTimeout(idle);
      handle.close();
      resolve(collected);
    };
    const reset = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(finish, 3000);
    };
    reset();
    (async () => {
      for await (const ev of handle) {
        reset();
        collected.push(ev);
        const d = ev.params.data;
        if (
          ev.method === "lifecycle" &&
          ev.params.namespace.length === 0 &&
          d?.event != null &&
          TERMINAL.has(d.event)
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
    assistantId: "agent",
  });

  // Early subscriber: opens BEFORE run.start. Should see the run from
  // ``running`` → ``completed`` end-to-end.
  const earlyHandle = await thread.subscribe({
    channels: ["lifecycle", "values"],
  });
  const earlyEvents: Event[] = [];
  let earlyEventsSeen = 0;
  const earlyDrain = (async () => {
    const TERMINAL = new Set(["completed", "failed", "interrupted"]);
    for await (const raw of earlyHandle) {
      const ev = raw as unknown as Event;
      earlyEvents.push(ev);
      earlyEventsSeen += 1;
      const d = ev.params.data as { event?: string } | undefined;
      if (
        ev.method === "lifecycle" &&
        ev.params.namespace.length === 0 &&
        d?.event != null &&
        TERMINAL.has(d.event)
      ) {
        earlyHandle.close();
        break;
      }
    }
  })();

  // Fire the run. ``sleep: 1.5`` keeps ``call_model`` blocked for
  // 1500ms so the early subscriber has plenty of time to accumulate
  // events before the late subscriber connects.
  console.log("--- Driving agent with sleep=1.5 ---\n");
  await thread.run.start({
    input: {
      messages: [{ role: "user", content: "hot-subscribe test" }],
      sleep: 1.5,
    },
  });

  // Wait until the early subscriber has picked up at least one event
  // (lifecycle.running arrives quickly after run.start). Then the
  // late subscriber opens while the run is still mid-flight.
  const t0 = Date.now();
  while (earlyEventsSeen === 0 && Date.now() - t0 < 3000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (earlyEventsSeen === 0) {
    throw new Error(
      "early subscription received no events in 3s — run did not start"
    );
  }
  console.log(
    `[t=${Date.now() - t0}ms] early subscription has ${earlyEventsSeen} event(s); opening late subscription`
  );
  const lateHandle = await thread.subscribe({
    channels: ["lifecycle", "values"],
  });
  const lateEvents = await collectUntilTerminal(lateHandle);
  await earlyDrain;
  await thread.close();

  console.log(
    `\nearly subscriber: ${earlyEvents.length} event(s)`
  );
  console.log(`late  subscriber: ${lateEvents.length} event(s)`);

  const earlyIds = new Set(
    earlyEvents
      .map((e) => e.event_id)
      .filter((id): id is string => typeof id === "string")
  );
  const lateIds = new Set(
    lateEvents
      .map((e) => e.event_id)
      .filter((id): id is string => typeof id === "string")
  );

  const missingFromLate = [...earlyIds].filter((id) => !lateIds.has(id));
  console.log(
    `event_ids the late subscriber missed: ${
      missingFromLate.length === 0
        ? "none"
        : missingFromLate.slice(0, 10).join(", ")
    }`
  );

  // Each subscription has its own session, so ``seq`` isn't shared
  // across them — but the underlying run's events ARE replayed, so
  // the set of ``event_id``s must match.
  console.log();
  console.log(
    `assertion — early sub captured run.start through completion: ${
      earlyEvents.length > 0 ? "✓" : "✗"
    }`
  );
  console.log(
    `assertion — late subscriber replayed the full run: ${
      missingFromLate.length === 0 ? "✓" : `✗ (${missingFromLate.length} gaps)`
    }`
  );
  const hasTerminalEarly = earlyEvents.some(
    (e) =>
      e.method === "lifecycle" &&
      e.params.namespace.length === 0 &&
      ((e.params.data as { event?: string }).event === "completed" ||
        (e.params.data as { event?: string }).event === "failed")
  );
  const hasTerminalLate = lateEvents.some(
    (e) =>
      e.method === "lifecycle" &&
      e.params.namespace.length === 0 &&
      ((e.params.data as { event?: string }).event === "completed" ||
        (e.params.data as { event?: string }).event === "failed")
  );
  console.log(
    `assertion — both subs saw root terminal lifecycle: ${
      hasTerminalEarly && hasTerminalLate
        ? "✓"
        : `✗ (early=${hasTerminalEarly}, late=${hasTerminalLate})`
    }`
  );
}

await main();
