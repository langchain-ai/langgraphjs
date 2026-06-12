/**
 * Exercises the auxiliary command surface on the Python langgraph-api:
 *
 *   - `agent.getTree` — returns the agent namespace tree with statuses.
 *   - `state.*` + `input.inject` — confirmed to return `not_supported`
 *     per the v0.5.0 thread-centric design.
 *   - `subscription.reconnect` — superseded by `Last-Event-ID` / `since`
 *     on SSE; returns `not_supported`.
 *   - Unknown command — confirm the dispatcher's `unknown_command` path.
 *   - Malformed envelope — confirm the route's `invalid_argument` path.
 *
 * Unlike the other api/ scripts, this one talks directly to the
 * `POST /threads/{thread_id}/commands` endpoint via `fetch` so we
 * can assert on the raw `ProtocolError` / `ProtocolSuccess` shapes
 * the server returns.
 *
 * Prereq:
 *   cd langgraph-api/api && make start
 *
 * Run:
 *   npx tsx src/api/commands.ts
 */

import { randomUUID } from "node:crypto";

import { apiUrl, requireServer } from "./_shared.js";

interface ProtocolResponse {
  type: "success" | "error";
  id: number | null;
  result?: Record<string, unknown>;
  error?: string;
  message?: string;
}

async function send(
  url: string,
  threadId: string,
  payload: Record<string, unknown>
): Promise<ProtocolResponse> {
  const res = await fetch(`${url}/threads/${threadId}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return (await res.json()) as ProtocolResponse;
}

function label(resp: ProtocolResponse): string {
  if (resp.type === "success") return `✓ success`;
  return `✗ ${resp.error}: ${resp.message}`;
}

async function main() {
  const url = apiUrl();
  await requireServer(url);

  const threadId = randomUUID();

  // 1. Start a run so a session exists to dispatch to.
  const started = await send(url, threadId, {
    id: 1,
    method: "run.start",
    params: {
      assistant_id: "agent_echo_stream",
      input: { messages: [{ role: "user", content: "commands-test" }] },
    },
  });
  console.log(`run.start ${label(started)} run_id=${started.result?.run_id}`);

  // Give the run a moment to start so attach_to_active_run picks it up.
  await new Promise((r) => setTimeout(r, 150));

  // 2. agent.getTree
  const tree = await send(url, threadId, {
    id: 2,
    method: "agent.getTree",
    params: {},
  });
  console.log(`agent.getTree ${label(tree)} tree=${JSON.stringify(tree.result?.tree).slice(0, 100)}`);

  // 3. state.get — intentionally not_supported on the protocol
  const stateGet = await send(url, threadId, {
    id: 3,
    method: "state.get",
    params: { namespace: [] },
  });
  console.log(`state.get ${label(stateGet)} (expect not_supported)`);

  // 4. input.inject — not yet implemented
  const inject = await send(url, threadId, {
    id: 4,
    method: "input.inject",
    params: { namespace: [], message: { role: "user", content: "hi" } },
  });
  console.log(`input.inject ${label(inject)} (expect not_supported)`);

  // 5. subscription.reconnect — superseded by Last-Event-ID / since
  const reconnect = await send(url, threadId, {
    id: 5,
    method: "subscription.reconnect",
    params: {},
  });
  console.log(
    `subscription.reconnect ${label(reconnect)} (expect not_supported)`
  );

  // 6. Unknown command
  const unknown = await send(url, threadId, {
    id: 6,
    method: "totally.made.up",
    params: {},
  });
  console.log(`unknown method ${label(unknown)} (expect unknown_command)`);

  // 7. Malformed envelope — missing method
  const malformed = await fetch(
    `${url}/threads/${threadId}/commands`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 7 }),
    }
  );
  const malformedBody = (await malformed.json()) as ProtocolResponse;
  console.log(
    `malformed envelope HTTP ${malformed.status} ${label(malformedBody)}`
  );
}

await main();
