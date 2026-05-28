/**
 * Failure propagation against the Python `langgraph-api` server.
 *
 * Drives the `agent` test-fixture graph and feeds it a ``throw_error``
 * input that causes ``call_model`` to ``raise ValueError("boom ...")``.
 * The background worker catches the exception, marks the run as
 * ``status = "error"``, and the run stream publishes a final ``error``
 * event. The protocol session maps that to a root-level
 * ``lifecycle.failed`` with the exception message attached.
 *
 * What this exercises on the server:
 *
 *   - ``Runs.enter`` cleanup after an exception: ``control done``
 *     ends the live-stream join.
 *   - ``RunProtocolSession._handle_source_event``'s ``error`` branch
 *     synthesizing ``lifecycle.failed`` with the user-facing message
 *     preserved in ``params.data.error``.
 *   - Client-visible failure: the SDK's ``thread.failed`` accessor
 *     (and a raw subscription) surface the same error string.
 *
 * Connect **live** (before the run actually fails). Late-connecting
 * clients — attached only after the run has already errored — currently
 * see ``lifecycle.failed`` without the error message body (the live
 * ``error`` event is not replayed from storage). This is captured in
 * ``docs/protocol-v2-implementation-plan.md`` under "Outstanding work".
 *
 * Prereq:
 *   cd langgraph-api/api && make start
 *
 * Run:
 *   npx tsx src/api/errors.ts
 */

import { Client } from "@langchain/langgraph-sdk";
import type { LifecycleEvent } from "@langchain/protocol";

import { apiUrl, requireServer, short } from "./_shared.js";

interface RawEvent {
  method: string;
  params: {
    namespace: readonly string[];
    data: unknown;
  };
}

async function main() {
  const url = apiUrl();
  await requireServer(url);

  const thread = new Client({ apiUrl: url }).threads.stream({
    assistantId: "agent",
  });

  // Open a raw lifecycle subscription *before* driving the run so we
  // catch the ``failed`` event as it fires, complete with the error
  // body ``_handle_source_event`` synthesizes from the source stream's
  // ``error`` frame.
  const lifecycleEvents: LifecycleEvent[] = [];
  const lifecycleSub = await thread.subscribe({
    channels: ["lifecycle"],
  });
  const lifecycleDrain = (async () => {
    for await (const raw of lifecycleSub) {
      const event = raw as LifecycleEvent;
      lifecycleEvents.push(event);
      // Terminal lifecycle at the root — break out so we don't hang on
      // heartbeats after the run is done.
      if (
        event.params.namespace.length === 0 &&
        ["failed", "completed", "interrupted"].includes(event.params.data.event)
      ) {
        break;
      }
    }
  })();

  console.log("--- Driving agent with throw_error=ValueError ---\n");
  await thread.run.start({
    input: {
      messages: [{ role: "user", content: "please fail" }],
      // agent.py reads ``throw_error`` out of state and raises with
      // ``exception_types[type](message)`` — see call_model().
      throw_error: {
        type: "ValueError",
        message: "boom from errors.ts",
      },
    },
  });

  await lifecycleDrain;
  await thread.close();

  const statuses = lifecycleEvents.map((e) => ({
    ns: e.params.namespace.join("/") || "(root)",
    event: e.params.data.event,
    error: e.params.data.error,
  }));

  console.log(`Collected ${lifecycleEvents.length} lifecycle event(s):`);
  for (const row of statuses) {
    const suffix = row.error ? `  error=${short(row.error, 80)}` : "";
    console.log(`  ns=${row.ns.padEnd(20)} event=${row.event}${suffix}`);
  }

  const terminal = lifecycleEvents.find(
    (e) =>
      e.params.namespace.length === 0 &&
      ["failed", "completed", "interrupted"].includes(e.params.data.event)
  );

  console.log();
  console.log(
    `assertion — root terminal lifecycle present: ${
      terminal ? "✓" : "✗"
    }`
  );
  console.log(
    `assertion — terminal event is "failed": ${
      terminal?.params.data.event === "failed" ? "✓" : `✗ (got "${terminal?.params.data.event}")`
    }`
  );
  const errorMsg = terminal?.params.data.error;
  const errorLooksRight =
    typeof errorMsg === "string" && errorMsg.includes("boom from errors.ts");
  console.log(
    `assertion — error message carried in params.data.error: ${
      errorLooksRight ? "✓" : `✗ (got ${JSON.stringify(errorMsg)})`
    }`
  );

  // Sanity: the run record on the REST surface also reflects ``error``.
  //
  // Timing note: ``stream.py :: consume`` enqueues the ``error`` frame
  // to the publish queue *before* re-raising the exception, so the SSE
  // client's ``lifecycle.failed`` can land a few ms before the worker's
  // ``Runs.set_joint_status(status="error")`` commits. Poll briefly so
  // we don't race.
  const lastStatus = await pollUntilTerminal(
    `${url}/threads/${thread.threadId}/runs`,
    2000
  );
  console.log(
    `assertion — REST /threads/{id}/runs reports status="error": ${
      lastStatus === "error" ? "✓" : `✗ (got "${lastStatus ?? "unknown"}")`
    }`
  );

  // Silence: no values snapshot should have been committed past the
  // failure point (the node raised before returning any state update).
  void ({} as RawEvent);
}

async function pollUntilTerminal(
  url: string,
  timeoutMs: number
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: string | undefined;
  while (Date.now() < deadline) {
    const res = await fetch(url);
    const runs = (await res.json()) as { status: string }[];
    lastStatus = runs.at(-1)?.status;
    if (
      lastStatus === "error" ||
      lastStatus === "success" ||
      lastStatus === "interrupted" ||
      lastStatus === "timeout"
    ) {
      return lastStatus;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return lastStatus;
}

await main();
