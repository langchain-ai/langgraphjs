/**
 * End-to-end verification of a user-defined ``StreamTransformer`` on the
 * Python ``langgraph-api`` server.
 *
 * Pairs with ``api/tests/graphs/agent_metrics_stream.py`` in the
 * ``langgraph-api`` repo, which registers a ``MetricsTransformer``
 * whose two ``StreamChannel`` projections surface on the wire as
 * CDDL ``CustomEvent`` values (``method: "custom"``, ``params.data``
 * shaped like ``{ name, payload }``):
 *
 *   - ``name: "counts"``  — running totals per stream method (one per
 *                           event the mux dispatches).
 *   - ``name: "summary"`` — one terminal snapshot emitted from
 *                           ``afinalize`` (flushed when the run ends).
 *
 * ``thread.extensions.<name>`` is the ergonomic per-projection
 * accessor. It lazily opens the shared ``"custom"`` subscription,
 * matches events by ``params.data.name``, and unwraps
 * ``params.data.payload`` so you iterate the raw payload type. Each
 * handle is both an ``AsyncIterable<Payload>`` (for streaming deltas)
 * and a ``PromiseLike<Payload>`` (for the last-observed value —
 * resolves on run end, useful for terminal snapshots like ``summary``).
 *
 * Prereq:
 *   cd langgraph-api/api && make start
 *
 * Run:
 *   npx tsx src/api/custom_transformer.ts
 */

import { Client } from "@langchain/langgraph-sdk";

import { apiUrl, requireServer } from "./_shared.js";

interface CountsPayload {
  method: string;
  total: number;
}

interface SummaryPayload {
  totals: Record<string, number>;
  distinct_methods: number;
}

type Extensions = {
  counts: AsyncIterable<CountsPayload>;
  summary: Promise<SummaryPayload>;
}

async function main() {
  const url = apiUrl();
  await requireServer(url);
  console.log(`--- Connected to langgraph-api at ${url} ---\n`);

  const client = new Client({ apiUrl: url });
  const thread = client.threads.stream<Extensions>({
    assistantId: "agent_metrics_stream",
  });

  // Kick off the run. ``MetricsTransformer`` emits one
  // ``custom:counts`` event per mux dispatch plus a terminal
  // ``custom:summary`` snapshot from ``afinalize``.
  await thread.run.start({
    input: {
      messages: [{ role: "user", content: "transformer-demo" }],
    },
  });

  console.log("--- thread.extensions.counts (streaming deltas) ---\n");

  let n = 0;
  for await (const delta of thread.extensions.counts) {
    n += 1;
    console.log(
      `  #${String(n).padStart(2, "0")} method=${delta.method.padEnd(12)} total=${delta.total}`
    );
  }
  console.log(`\n(${n} counts deltas)\n`);

  console.log("--- thread.extensions.summary (terminal snapshot) ---\n");

  // ``extensions.<name>`` is also ``PromiseLike`` — awaiting resolves
  // with the last-observed payload once the run terminates.
  const finalSummary = await thread.extensions.summary;
  if (finalSummary) {
    console.log(
      `distinct methods: ${finalSummary.distinct_methods}\n` +
        `totals: ${JSON.stringify(finalSummary.totals, null, 2)}`
    );
  } else {
    console.log("(no summary received — check that agent_metrics_stream");
    console.log(" is registered and the server was restarted after adding it)");
  }

  await thread.close();
}

await main();
