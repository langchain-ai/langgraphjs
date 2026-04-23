/**
 * Memory MRE service.
 *
 * Endpoints:
 *   GET  /health       liveness probe + memory glance
 *   GET  /metrics      full memory snapshot as JSON
 *   POST /run          SSE stream — pipes deepagents output directly to
 *                      the client over HTTP, exercising the real streaming
 *                      and backpressure path.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { snap, startPeriodicSampler, instrumentSSEStream, T0_MS } from "./telemetry.js";
import { runStream } from "./runner.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const SAMPLE_INTERVAL_MS = parseInt(
  process.env.SAMPLE_INTERVAL_MS ?? "100",
  10,
);

startPeriodicSampler(SAMPLE_INTERVAL_MS);

const app = new Hono();

app.get("/health", (c) => {
  const s = snap();
  return c.json({
    ok: true,
    uptime_ms: s.t_ms,
    rss_mb: +(s.rss / 1024 / 1024).toFixed(1),
    heap_used_mb: +(s.heap_used / 1024 / 1024).toFixed(1),
  });
});

app.get("/metrics", (c) => {
  return c.json(snap());
});

app.post("/run", async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    // empty body OK — use defaults
  }

  try {
    const sseStream = await runStream({
      message: body?.message,
      model: body?.model,
      streamMode: body?.streamMode,
      subgraphs: body?.subgraphs,
    });

    // Wrap the SSE stream with telemetry so we capture pre/post/peak
    // memory snapshots around the *full stream lifecycle* — not just
    // around the stream creation (which returns immediately).
    const label = body?.label ?? "run";
    const instrumented = instrumentSSEStream(label, sseStream);

    // Pipe the instrumented SSE ReadableStream directly to the HTTP
    // response. Chunks flow over the wire as they're produced by the
    // Pregel engine, and telemetry fires when the stream closes.
    return new Response(instrumented, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" });
process.stdout.write(
  JSON.stringify({
    ev: "server_start",
    port: PORT,
    sample_interval_ms: SAMPLE_INTERVAL_MS,
    model: process.env.MODEL_NAME ?? "(default)",
    t_ms: Date.now() - T0_MS(),
  }) + "\n",
);
