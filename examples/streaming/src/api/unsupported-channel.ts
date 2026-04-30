/**
 * Malformed / unsupported subscribe-envelope validation against the
 * Python `langgraph-api` server.
 *
 * Goes at the raw HTTP layer (``fetch`` → ``POST /events``) so we can
 * assert on the ``invalid_argument`` / HTTP 4xx shapes the server
 * returns. The SDK sanitizes most of these before they reach the
 * wire; this script hits the validator directly.
 *
 * Matrix (fresh thread per row):
 *
 *   ``channels: []``                      → HTTP 400 invalid_argument
 *   ``channels: ["unknown"]``             → HTTP 400 invalid_argument
 *   ``channels: ["values", "unknown"]``   → HTTP 400 invalid_argument
 *   ``channels: ["debug"]``               → HTTP 400 invalid_argument
 *                                            (removed in protocol 0.0.10)
 *   ``channels: ["checkpoints"]``         → HTTP 400 invalid_argument
 *                                            (removed in protocol 0.0.10)
 *   ``channels: ["custom:my-event"]``     → HTTP 200 (valid custom:* form)
 *   ``channels: ["values"], depth: "1"``  → HTTP 200 (unknown/invalid
 *                                            ``depth`` types are coerced
 *                                            to None server-side, not
 *                                            validated strictly)
 *   ``channels: ["values"], namespaces: {}`` → HTTP 200 (non-list
 *                                            ``namespaces`` is
 *                                            silently ignored)
 *
 * The last two exercise the server's *tolerant* coercion — see
 * ``_thread_events`` in ``api/langgraph_api/api/protocol.py``:
 * unrecognized ``depth`` / ``namespaces`` shapes fall back to the
 * no-filter default. That's intentional so older clients don't crash
 * the stream.
 *
 * Prereq:
 *   cd langgraph-api/api && make start
 *
 * Run:
 *   npx tsx src/api/unsupported-channel.ts
 */

import { randomUUID } from "node:crypto";

import { apiUrl, requireServer } from "./_shared.js";

interface Probe {
  label: string;
  body: Record<string, unknown>;
  expect:
    | { status: 400; errorCode?: string }
    | { status: 200; reason: string };
}

const PROBES: readonly Probe[] = [
  {
    label: "empty channels array",
    body: { channels: [] },
    expect: { status: 400 },
  },
  {
    label: "unknown channel name",
    body: { channels: ["totally-made-up"] },
    expect: { status: 400 },
  },
  {
    label: "mixed valid + unknown",
    body: { channels: ["values", "totally-made-up"] },
    expect: { status: 400 },
  },
  {
    label: 'dropped channel "debug" (protocol 0.0.10)',
    body: { channels: ["debug"] },
    expect: { status: 400 },
  },
  {
    label: 'dropped channel "checkpoints" (protocol 0.0.10)',
    body: { channels: ["checkpoints"] },
    expect: { status: 400 },
  },
  {
    label: 'user-defined "custom:my-event"',
    body: { channels: ["custom:my-event"] },
    expect: { status: 200, reason: "custom:<name> form is explicitly valid" },
  },
  {
    label: "depth as string (should be tolerantly ignored)",
    body: { channels: ["values"], depth: "1" },
    expect: { status: 200, reason: "bad-type depth falls back to None" },
  },
  {
    label: "namespaces as dict (should be tolerantly ignored)",
    body: { channels: ["values"], namespaces: { foo: "bar" } },
    expect: { status: 200, reason: "bad-type namespaces falls back to None" },
  },
];

async function probe(url: string, threadId: string, p: Probe) {
  const res = await fetch(`${url}/v2/threads/${threadId}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify(p.body),
  });

  let detail: string | undefined;
  let errorCode: string | undefined;
  if (res.status !== 200) {
    try {
      const body = (await res.json()) as {
        detail?: string;
        error?: string;
      };
      detail = body.detail;
      errorCode = body.error;
    } catch {
      detail = await res.text();
    }
  } else {
    // We don't need to read the stream body — the server accepted the
    // envelope, which is all we're asserting here. Close the connection
    // so undici releases the keep-alive slot for the next probe.
    await res.body?.cancel();
  }

  const ok =
    p.expect.status === res.status &&
    (p.expect.status !== 400 ||
      p.expect.errorCode == null ||
      errorCode === p.expect.errorCode);
  const label = ok ? "✓" : "✗";
  const suffix =
    res.status === 200
      ? ""
      : `  error=${errorCode ?? "?"}${
          detail ? ` detail=${detail.slice(0, 80)}` : ""
        }`;
  console.log(
    `  ${label} ${res.status}  ${p.label.padEnd(50)}${suffix}`
  );
  return ok;
}

async function main() {
  const url = apiUrl();
  await requireServer(url);

  console.log("Subscribe-envelope validation probes:\n");

  let passes = 0;
  for (const p of PROBES) {
    // Use a fresh thread per probe so one bad request can't poison the
    // next. The thread doesn't need to have a run — we're just
    // exercising the envelope validator in ``_thread_events``.
    const threadId = randomUUID();
    if (await probe(url, threadId, p)) passes += 1;
  }

  console.log();
  console.log(
    `${passes}/${PROBES.length} probes matched the expected response.`
  );
  if (passes !== PROBES.length) {
    process.exitCode = 1;
  }
}

await main();
