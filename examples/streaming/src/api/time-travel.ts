/**
 * Time-travel demo for protocol v2: every ``values`` event carries a
 * ``ValuesCheckpoint`` envelope (CDDL §12) with ``{id, parent_id?,
 * step, source}`` so clients can build branching / fork UIs from the
 * event stream alone — no side-band ``state.get`` /
 * ``state.listCheckpoints`` lookup required.
 *
 * This script:
 *
 *   1. Runs ``agent_echo_stream`` twice on one thread ("Hello",
 *      "Goodbye"), collecting every checkpoint that rides on a values
 *      event. The envelopes form a linear chain linked by ``parent_id``.
 *   2. Picks an earlier checkpoint from that chain and forks a new
 *      run from it with a different input ("Howdy"). The forked run's
 *      first root-namespace values event arrives with ``parent_id``
 *      pointing back at the fork target — proving the envelope is
 *      the only piece of metadata a client needs to build a proper
 *      time-travel tree.
 *
 * All three runs go through ``thread.run.start`` on the same
 * ``client.threads.stream`` handle. The fork is expressed by threading
 * ``config.configurable.checkpoint_id`` into the protocol command —
 * LangGraph's Pregel reads that and starts the run from the selected
 * checkpoint's state. The protocol does not yet have a first-class
 * ``state.fork`` command (roadmap §1.2), but the configurable override
 * is spec-compliant and works today.
 *
 * Observation uses a *fresh* ``thread.subscribe(...)`` per run. The
 * server's SSE session is currently single-run-bound:
 * ``attach_to_active_run`` fires once at subscribe time and
 * ``_consume_source`` exits on terminal lifecycle, so a long-lived
 * subscription only ever sees one run's events. Opening a new
 * subscription after firing ``run.start`` binds the session to the
 * just-enqueued run, and ``_make_source_from_sub`` replays from
 * ``last_event_id="0"`` so late attachers still see everything that
 * fired before they connected. Tracked as outstanding work §11 in the
 * protocol-v2 implementation plan; once per-thread session carry-over
 * lands, the three ``subscribe``/``unsubscribe`` pairs below can
 * collapse into one long-lived loop.
 *
 * Note: ``thread.values`` — the ergonomic projection — would strip
 * ``params.checkpoint`` in its own callback, so envelope-aware
 * consumers use raw ``thread.subscribe`` / ``SubscriptionHandle``.
 *
 * Prereq:
 *   cd langgraph-api/api && make start
 *
 * Run:
 *   npx tsx src/api/time-travel.ts
 */

import { Client } from "@langchain/langgraph-sdk";
import type { ValuesEvent } from "@langchain/protocol";

import { apiUrl, requireServer } from "./_shared.js";

interface ValuesCheckpoint {
  id: string;
  parent_id?: string;
  step: number;
  source: "input" | "loop" | "update" | "fork";
}

const ASSISTANT_ID = "agent_echo_stream";
const TERMINAL_LIFECYCLE = new Set(["completed", "failed", "interrupted"]);

/**
 * Open a fresh subscription on the given thread, collect every
 * root-namespace ``ValuesCheckpoint`` envelope that rides on a
 * ``values`` event, and return once the terminal root-namespace
 * ``lifecycle`` frame arrives.
 */
async function collectRunCheckpoints(
  thread: ReturnType<Client["threads"]["stream"]>
): Promise<ValuesCheckpoint[]> {
  const sub = await thread.subscribe(["values", "lifecycle"]);
  const checkpoints: ValuesCheckpoint[] = [];
  try {
    for await (const event of sub) {
      if (event.method === "values" && event.params.namespace.length === 0) {
        const checkpoint = (event as ValuesEvent).params.checkpoint as
          | ValuesCheckpoint
          | undefined;
        if (checkpoint) checkpoints.push(checkpoint);
      }
      if (
        event.method === "lifecycle" &&
        event.params.namespace.length === 0
      ) {
        const data = event.params.data as { event?: string } | undefined;
        if (data?.event && TERMINAL_LIFECYCLE.has(data.event)) break;
      }
    }
  } finally {
    await sub.unsubscribe();
  }
  return checkpoints;
}

function short(id: string): string {
  if (id.length <= 13) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function fmt(c: ValuesCheckpoint): string {
  const parent = c.parent_id ? short(c.parent_id) : "∅ (root)";
  const step = c.step.toString().padStart(2);
  return `  step=${step}  source=${c.source.padEnd(6)}  ${short(c.id)}  ← ${parent}`;
}

async function main() {
  const url = apiUrl();
  await requireServer(url);

  const client = new Client({ apiUrl: url });
  const thread = client.threads.stream({ assistantId: ASSISTANT_ID });

  try {
    console.log(`thread ${thread.threadId}\n`);

    // ── Run 1 ───────────────────────────────────────────────────────────
    // Command first, subscribe second. Each ``thread.subscribe`` opens a
    // fresh SSE whose session binds to the most recent run on the
    // thread via ``attach_to_active_run``; firing ``run.start`` before
    // we subscribe guarantees the right run is picked up.
    console.log("─── Run 1: user 'Hello' ─────────────────────────────────────");
    await thread.run.start({
      input: { messages: [{ role: "user", content: "Hello" }] },
    });
    const run1 = await collectRunCheckpoints(thread);
    for (const c of run1) console.log(fmt(c));

    // ── Run 2 ───────────────────────────────────────────────────────────
    console.log("\n─── Run 2: user 'Goodbye' (same thread) ─────────────────────");
    await thread.run.start({
      input: { messages: [{ role: "user", content: "Goodbye" }] },
    });
    const run2 = await collectRunCheckpoints(thread);
    for (const c of run2) console.log(fmt(c));

    const chain = [...run1, ...run2];
    console.log(
      `\n${chain.length} checkpoints across 2 runs — each values event carried`
    );
    console.log("params.checkpoint, no out-of-band lookup needed.\n");

    // ── Fork from an earlier checkpoint ────────────────────────────────
    // The earliest "loop" checkpoint represents the state right after
    // Run 1 finished but before "Goodbye" was appended. Branching there
    // with a different message lets us observe the same "Run 2" superstep
    // with alternate input. The parent_id on the forked run's first
    // checkpoint should match our fork target.
    const forkTarget = run1.find((c) => c.source === "loop") ?? run1[0];
    if (!forkTarget) {
      console.log("No checkpoint to fork from; aborting.");
      return;
    }

    console.log(
      `─── Fork from ${short(forkTarget.id)} with user 'Howdy' ──────────────`
    );
    console.log(
      "  (state.fork is not yet a protocol command — routing through run.start"
    );
    console.log(
      "   with config.configurable.checkpoint_id, which Pregel picks up as"
    );
    console.log("   the starting checkpoint for the run.)\n");

    await thread.run.start({
      input: { messages: [{ role: "user", content: "Howdy" }] },
      config: { configurable: { checkpoint_id: forkTarget.id } },
    });
    const forked = await collectRunCheckpoints(thread);
    for (const c of forked) console.log(fmt(c));

    // Confirm the branch linkage.
    const forkRoot = forked[0];
    if (forkRoot?.parent_id === forkTarget.id) {
      console.log(
        `\n✓ Forked run's first checkpoint has parent_id=${short(forkTarget.id)}`
      );
      console.log(
        "  — the branch is fully described by the values envelope. A client could"
      );
      console.log(
        "  render a complete branching tree from these events, no extra API calls."
      );
    } else if (forkRoot) {
      console.log(
        `\n⚠ Expected parent_id=${short(forkTarget.id)} on the forked run's first`
      );
      console.log(
        `  checkpoint; got parent_id=${
          forkRoot.parent_id ? short(forkRoot.parent_id) : "∅"
        }. The fork may have coalesced into a different superstep.`
      );
    }
  } finally {
    await thread.close();
  }
}

await main();
