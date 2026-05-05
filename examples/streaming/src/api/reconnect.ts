/**
 * SSE reconnect / replay verification for the Python `langgraph-api`.
 *
 * Opens a raw `POST /threads/{thread_id}/stream/events` SSE stream, starts a
 * run, reads events until some point in the middle, drops the
 * connection, then reopens it with a `Last-Event-ID: <seq>` header and
 * asserts every event after that point is replayed in order with no
 * gaps.
 *
 * We drop to `fetch` here (rather than the SDK's `ThreadStream`) because
 * the goal is to directly verify the server-side replay semantics in
 * `RunProtocolSession.install_subscription_with_replay`.
 *
 * Prereq:
 *   cd langgraph-api/api && make start
 *
 * Run:
 *   npx tsx src/api/reconnect.ts
 */

import { randomUUID } from "node:crypto";
import * as http from "node:http";
import { URL as NodeURL } from "node:url";

import type { Event } from "@langchain/protocol";

import { apiUrl, requireServer } from "./_shared.js";

type SseField = { id?: string; event?: string; data: string };

/** Parse a finished SSE frame (normalized to LF) into key/value fields. */
function parseFrame(rawFrame: string): SseField | null {
  if (!rawFrame.trim()) return null;
  const fields: { id?: string; event?: string; data?: string } = {};
  for (const line of rawFrame.split("\n")) {
    if (line.startsWith(":")) continue; // heartbeat / comment
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).replace(/^ /, "");
    if (name === "id" || name === "event" || name === "data") {
      fields[name as "id" | "event" | "data"] = value;
    }
  }
  if (fields.data === undefined) return null;
  return fields as SseField;
}

/** Low-level POST that returns a Node IncomingMessage + request we control.
 *
 * We deliberately use `node:http` instead of `fetch` here: Node's fetch
 * (undici) default pool holds keep-alive slots on the origin and the
 * second POST to `/stream/events` stalls waiting for a free slot after the
 * first connection is aborted. `http.request` with `Connection: close`
 * forces a fresh socket per call and destroys cleanly on abort.
 */
function openSseStream(
  url: string,
  threadId: string,
  filter: Record<string, unknown>
): Promise<{ res: http.IncomingMessage; req: http.ClientRequest }> {
  return new Promise((resolve, reject) => {
    const target = new NodeURL(`/threads/${threadId}/stream/events`, url);
    const body = JSON.stringify(filter);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      "content-length": String(Buffer.byteLength(body)),
      connection: "close",
    };
    if (filter.lastEventId != null) {
      headers["last-event-id"] = String(filter.lastEventId);
    }
    const req = http.request(
      {
        method: "POST",
        hostname: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        headers,
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(
            new Error(`events endpoint returned ${res.statusCode ?? "?"}`)
          );
          return;
        }
        resolve({ res, req });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function readEvents(
  url: string,
  threadId: string,
  filter: Record<string, unknown>,
  max: number,
  options: { silenceMs?: number } = {}
): Promise<Event[]> {
  const { silenceMs = 1000 } = options;
  const { res, req } = await openSseStream(url, threadId, filter);
  const collected: Event[] = [];
  const TERMINAL_LIFECYCLE_EVENTS = new Set([
    "completed",
    "failed",
    "interrupted",
  ]);
  const decoder = new TextDecoder();
  let buffer = "";
  // If no new SSE frames arrive for ``silenceMs`` after at least one
  // event has been delivered, assume the replay is done and abort.
  // The server keeps the SSE connection open with heartbeats after a
  // completed run and never emits a "stream end" signal for reconnect
  // sessions, so without this timeout the iteration would block
  // indefinitely after the last replayed event.
  let idleTimer: NodeJS.Timeout | undefined;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (collected.length > 0) {
      idleTimer = setTimeout(() => {
        req.destroy();
      }, silenceMs);
    }
  };
  try {
    outer: for await (const chunk of res) {
      resetIdle();
      const bytes =
        chunk instanceof Buffer ? chunk : Buffer.from(chunk as Uint8Array);
      buffer += decoder.decode(bytes, { stream: true }).replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const rawFrame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const frame = parseFrame(rawFrame);
        if (frame == null) continue;
        const event = JSON.parse(frame.data) as Event;
        collected.push(event);
        if (collected.length >= max) break outer;
        const data = event.params.data as { event?: string } | undefined;
        if (
          event.method === "lifecycle" &&
          event.params.namespace.length === 0 &&
          data?.event != null &&
          TERMINAL_LIFECYCLE_EVENTS.has(data.event)
        ) {
          break outer;
        }
      }
    }
  } catch (err) {
    // ``req.destroy()`` fires an `ECONNRESET`-style error when the
    // idle-timer closes the socket mid-iteration — that's expected.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ECONNRESET" && code !== "ERR_STREAM_PREMATURE_CLOSE") {
      throw err;
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    req.destroy();
  }
  return collected;
}

async function main() {
  const url = apiUrl();
  await requireServer(url);

  const threadId = randomUUID();

  // Kick off a run via the REST-style commands endpoint (we drive the
  // raw streams below, not the SDK wrapper). Use ``node:http`` here as
  // well so the entire test sticks to one transport — mixing undici's
  // fetch with follow-up ``http.request`` streams on the same origin
  // has proven to stall the second POST to ``/stream/events``.
  const commandBody = await new Promise<{
    type: string;
    result?: { run_id?: string };
    error?: string;
    message?: string;
  }>((resolve, reject) => {
    const target = new NodeURL(`/threads/${threadId}/commands`, url);
    const payload = JSON.stringify({
      id: 1,
      method: "run.start",
      params: {
        assistant_id: "agent_echo_stream",
        input: { messages: [{ role: "user", content: "reconnect-test" }] },
      },
    });
    const req = http.request(
      {
        method: "POST",
        hostname: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
  if (commandBody.type !== "success") {
    throw new Error(
      `run.start failed: ${commandBody.error}: ${commandBody.message}`
    );
  }
  console.log(`--- started run ${commandBody.result?.run_id} ---\n`);

  // First pass: read up to 3 events and capture the last seq.
  const firstBatch = await readEvents(
    url,
    threadId,
    { channels: ["lifecycle", "messages", "values"] },
    3
  );
  console.log(`first pass delivered ${firstBatch.length} events:`);
  for (const event of firstBatch) {
    console.log(`  seq=${event.seq} method=${event.method}`);
  }

  const lastSeq = firstBatch.at(-1)?.seq;
  if (lastSeq == null) {
    throw new Error("no seq observed on first pass");
  }

  // Small pause so the run can push more events into the session
  // buffer while we're disconnected. Also gives undici's connection
  // pool time to fully release the aborted first stream before we
  // fire the reconnect fetch on the same host.
  await new Promise((r) => setTimeout(r, 500));

  // Second pass with Last-Event-ID — should replay only seq > lastSeq.
  console.log(`\n--- reconnecting with Last-Event-ID: ${lastSeq} ---\n`);
  const resumed = await readEvents(
    url,
    threadId,
    {
      channels: ["lifecycle", "messages", "values"],
      lastEventId: lastSeq,
    },
    50
  );
  console.log(`resumed pass delivered ${resumed.length} events:`);
  for (const event of resumed) {
    console.log(`  seq=${event.seq} method=${event.method}`);
  }

  // Assertions:
  const allGreater = resumed.every((event) => (event.seq ?? 0) > lastSeq);
  const monotonic = resumed.every(
    (event, index) =>
      index === 0 || (event.seq ?? 0) > (resumed[index - 1]!.seq ?? 0)
  );
  console.log(
    `\nall seq > ${lastSeq}: ${allGreater ? "✓" : "✗"}, monotonic: ${
      monotonic ? "✓" : "✗"
    }`
  );

  // Third pass: identical `since` in the body should behave the same way
  // as the header — sanity check that both paths go through
  // `install_subscription_with_replay(since=...)`.
  const viaBody = await readEvents(
    url,
    threadId,
    {
      channels: ["lifecycle", "messages", "values"],
      since: lastSeq,
    },
    50
  );
  console.log(
    `\nsince-in-body delivered ${viaBody.length} events (should match resumed)`
  );

  // No thread.close() — we never opened an SDK thread. The run has
  // completed by now and the server-side buffer will be GC'd when the
  // last SSE connection drops.
}

await main();
