/**
 * Ramp-to-failure load generator for the memory MRE service.
 *
 * Doubles concurrency each level (1 → 2 → 4 → 8 → ...) until the
 * container OOMs, error rate spikes, or max concurrency is reached.
 *
 * Runs three concurrent activities:
 *   1. Ramp driver — fires requests at escalating concurrency
 *   2. Docker stats poller — container-level memory via `docker stats`
 *   3. App metrics poller — application-level memory via /metrics
 *
 * All events are written to a single JSONL file for analysis.
 *
 * Usage:
 *   npx tsx loadgen/ramp.ts \
 *     --base http://localhost:3000 \
 *     --container mre-service \
 *     --requests-per-level 4 \
 *     --cooldown 15 \
 *     --max-concurrency 16 \
 *     --out results/ramp-$(date +%s).jsonl
 */
import {
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { dirname } from "node:path";
import { request as httpRequest } from "node:http";

// ── CLI arg parsing ─────────────────────────────────────────────────

const PRESSURE_PROMPT = [
  "I need comprehensive research on 8 different topics. For EACH topic,",
  "delegate to a separate subagent and have them do thorough web research.",
  "The topics are:",
  "1. The history and current state of quantum computing in 2025",
  "2. Recent breakthroughs in nuclear fusion energy",
  "3. The evolution of large language models from GPT-1 to current models",
  "4. Current Mars exploration missions and their findings",
  "5. The state of global climate policy after COP29",
  "6. Advances in CRISPR gene editing therapy in humans",
  "7. The current landscape of autonomous vehicle regulation worldwide",
  "8. Recent developments in room-temperature superconductors",
  "",
  "For each topic, search the web for the latest information,",
  "extract key details from at least 2 sources, and write a detailed",
  "2-paragraph summary. Return all 8 summaries in a single structured report.",
].join("\n");

const DEFAULTS = {
  base: "http://localhost:3000",
  container: "mre-service",
  requestsPerLevel: 4,
  cooldown: 15,
  maxConcurrency: 16,
  metricsIntervalMs: 200,
  dockerIntervalMs: 200,
  out: "",
  prompt: "",
  // Per-request timeout: deepagents can take a while with heavy prompts
  requestTimeoutMs: 10 * 60 * 1000,
};

function parseArgs(): typeof DEFAULTS {
  const args = process.argv.slice(2);
  const out = { ...DEFAULTS };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (!arg.startsWith("--")) continue;
    // Convert --requests-per-level to requestsPerLevel
    const key = arg
      .slice(2)
      .replace(/-([a-z])/g, (_, c) => c.toUpperCase()) as keyof typeof DEFAULTS;
    if (next !== undefined && !next.startsWith("--")) {
      const n = Number(next);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (out as any)[key] = Number.isNaN(n) ? next : n;
      i++;
    }
  }
  return out;
}

const cfg = parseArgs();
const BASE = cfg.base;
const CONTAINER = cfg.container;
const REQUESTS_PER_LEVEL = cfg.requestsPerLevel;
const COOLDOWN_S = cfg.cooldown;
const MAX_CONCURRENCY = cfg.maxConcurrency;
const METRICS_INTERVAL = cfg.metricsIntervalMs;
const DOCKER_INTERVAL = cfg.dockerIntervalMs;
const REQUEST_TIMEOUT = cfg.requestTimeoutMs;
const PROMPT = (() => {
  const p = (cfg.prompt as string) || "";
  if (p === "pressure") return PRESSURE_PROMPT;
  return p;
})();
const OUT = cfg.out || `results/ramp-${Date.now()}.jsonl`;

// Ensure output dir exists
const dir = dirname(OUT);
if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
writeFileSync(OUT, ""); // truncate

function appendEv(ev: Record<string, unknown>) {
  appendFileSync(OUT, JSON.stringify(ev) + "\n");
}

// ── Docker stats poller ─────────────────────────────────────────────
// Uses the Docker Engine API via unix socket for:
//   - Async, non-blocking polling (no execSync blocking the event loop)
//   - Access to memory_stats.max_usage (high-water mark)
//   - True ~200ms resolution instead of ~2s from `docker stats --no-stream`

const DOCKER_SOCKET = process.env.DOCKER_HOST ?? "/var/run/docker.sock";

interface DockerMemoryStats {
  usage: number;
  max_usage: number;
  limit: number;
  stats?: { rss?: number };
}

interface DockerCpuUsage {
  total_usage: number;
  system_cpu_usage?: number;
}

interface DockerStatsResponse {
  memory_stats: DockerMemoryStats;
  cpu_stats: { cpu_usage: DockerCpuUsage; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats: { cpu_usage: DockerCpuUsage; system_cpu_usage?: number };
}

let prevCpuTotal = 0;
let prevSystemCpu = 0;

function dockerApiGet(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const opts = {
      socketPath: DOCKER_SOCKET,
      path,
      method: "GET",
      timeout: 3000,
    };
    const req = httpRequest(opts, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

async function pollDockerStats(): Promise<boolean> {
  try {
    const raw = await dockerApiGet(
      `/containers/${CONTAINER}/stats?stream=false`,
    );
    if (!raw) return false;
    const stats: DockerStatsResponse = JSON.parse(raw);

    const mem = stats.memory_stats;
    const toMB = (b: number) => +(b / 1024 / 1024).toFixed(1);

    // CPU % calculation (same formula as `docker stats`)
    const cpuDelta =
      stats.cpu_stats.cpu_usage.total_usage - prevCpuTotal;
    const sysDelta =
      (stats.cpu_stats.system_cpu_usage ?? 0) - prevSystemCpu;
    const onlineCpus = stats.cpu_stats.online_cpus ?? 1;
    const cpuPct =
      sysDelta > 0 ? +((cpuDelta / sysDelta) * onlineCpus * 100).toFixed(1) : 0;
    prevCpuTotal = stats.cpu_stats.cpu_usage.total_usage;
    prevSystemCpu = stats.cpu_stats.system_cpu_usage ?? 0;

    appendEv({
      ev: "docker_stats",
      t: Date.now(),
      container_mem_usage_mb: toMB(mem.usage),
      container_mem_limit_mb: toMB(mem.limit),
      container_mem_pct: +((mem.usage / mem.limit) * 100).toFixed(1),
      container_rss_mb: toMB(mem.stats?.rss ?? 0),
      container_mem_max_usage_mb: toMB(mem.max_usage),
      container_cpu_pct: cpuPct,
    });
    return true;
  } catch {
    return false;
  }
}

// ── App metrics poller ──────────────────────────────────────────────

async function pollAppMetrics(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/metrics`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) return false;
    const json = await r.json();
    appendEv({ ev: "app_metrics", t: Date.now(), ...json });
    return true;
  } catch {
    return false;
  }
}

// ── Health check ────────────────────────────────────────────────────

async function waitForHealth(): Promise<boolean> {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return true;
    } catch {
      // still starting up
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function isHealthy(retries = 3): Promise<boolean> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const r = await fetch(`${BASE}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Connection refused = container is actually dead
      if (msg.includes("ECONNREFUSED") || msg.includes("ECONNRESET")) {
        return false;
      }
      // Timeout or other transient error — retry
    }
    if (attempt < retries - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return false;
}

// ── Request driver ──────────────────────────────────────────────────

interface SSEDrainResult {
  events: number;
  bytes: number;
  /** Distinct subgraph namespaces seen (from SSE event type "mode|ns1|ns2") */
  namespaces: string[];
  /** Count of events per stream mode (values, messages, updates, etc.) */
  eventsByMode: Record<string, number>;
}

/**
 * Consume an SSE ReadableStream, counting events, bytes, and tracking
 * subgraph namespaces. Each SSE event line looks like:
 *   event: values              (root graph)
 *   event: values|child:abc    (subgraph)
 *   event: messages|child:abc|grandchild:def  (nested subgraph)
 *
 * The part before the first "|" is the stream mode; everything after
 * is the namespace path identifying which agent/subagent produced it.
 */
async function drainSSEStream(
  body: ReadableStream<Uint8Array>,
): Promise<SSEDrainResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let events = 0;
  let bytes = 0;
  let buffer = "";
  const namespacesSet = new Set<string>();
  const eventsByMode: Record<string, number> = {};

  function processEvent(eventText: string) {
    events += 1;
    // Parse the "event: <type>" line
    const eventLine = eventText
      .split("\n")
      .find((line) => line.startsWith("event:"));
    if (!eventLine) return;

    const eventType = eventLine.slice("event:".length).trim();
    // Format: "mode" or "mode|ns1|ns2|..."
    const parts = eventType.split("|");
    const mode = parts[0];
    eventsByMode[mode] = (eventsByMode[mode] ?? 0) + 1;

    if (parts.length > 1) {
      // Has a namespace — this is from a subgraph
      const ns = parts.slice(1).join("|");
      namespacesSet.add(ns);
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    buffer += decoder.decode(value, { stream: true });
    // Split on double-newline boundaries (SSE event separator)
    const parts = buffer.split("\n\n");
    // All but the last part are complete events
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i].trim().length > 0) {
        processEvent(parts[i]);
      }
    }
    buffer = parts[parts.length - 1];
  }
  // Any trailing content counts as a final event
  if (buffer.trim().length > 0) {
    processEvent(buffer);
  }

  return {
    events,
    bytes,
    namespaces: [...namespacesSet].sort(),
    eventsByMode,
  };
}

async function runOneRequest(
  requestIdx: number,
  concurrency: number,
): Promise<{ ok: boolean }> {
  appendEv({
    ev: "request_start",
    t: Date.now(),
    concurrency,
    request_idx: requestIdx,
  });

  const t0 = Date.now();
  let ok = false;
  let statusCode = 0;
  let sseEvents = 0;
  let sseBytes = 0;
  let drainResult: SSEDrainResult | undefined;
  let errorMessage: string | undefined;

  try {
    const r = await fetch(`${BASE}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: `ramp-${requestIdx}`,
        ...(PROMPT ? { message: PROMPT } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    statusCode = r.status;

    if (r.ok && r.body) {
      // Stream the SSE response — this exercises the real backpressure
      // path where the server's ReadableStream is piped over HTTP.
      drainResult = await drainSSEStream(r.body);
      sseEvents = drainResult.events;
      sseBytes = drainResult.bytes;
      ok = true;
    } else {
      // Non-SSE error response — try to read as JSON
      try {
        const errBody = await r.json();
        errorMessage = errBody?.error ?? `HTTP ${r.status}`;
      } catch {
        errorMessage = `HTTP ${r.status}`;
      }
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const duration_ms = Date.now() - t0;

  appendEv({
    ev: "request_end",
    t: Date.now(),
    concurrency,
    request_idx: requestIdx,
    ok,
    status_code: statusCode,
    duration_ms,
    sse_events: sseEvents,
    sse_bytes: sseBytes,
    subgraph_count: drainResult?.namespaces.length ?? 0,
    namespaces: drainResult?.namespaces,
    events_by_mode: drainResult?.eventsByMode,
    error: errorMessage,
  });

  return { ok };
}

async function driveLevel(
  concurrency: number,
  total: number,
  baseIdx: number,
): Promise<{ ok: number; failed: number }> {
  let nextIdx = baseIdx;
  const end = baseIdx + total;
  let okCount = 0;
  let failCount = 0;

  async function worker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= end) return;
      const result = await runOneRequest(idx, concurrency);
      if (result.ok) okCount++;
      else failCount++;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, () => worker()),
  );

  return { ok: okCount, failed: failCount };
}

// ── Main ramp loop ──────────────────────────────────────────────────

async function main() {
  console.log(`Memory MRE load generator`);
  console.log(`  Target: ${BASE}`);
  console.log(`  Container: ${CONTAINER}`);
  console.log(`  Ramp: 1 → ${MAX_CONCURRENCY} (×2), ${REQUESTS_PER_LEVEL} reqs/level`);
  console.log(`  Prompt: ${PROMPT ? PROMPT.slice(0, 80) + "..." : "(default)"}`);
  console.log(`  Output: ${OUT}`);
  console.log();

  const healthy = await waitForHealth();
  if (!healthy) {
    console.error(`Service at ${BASE} never became healthy; giving up.`);
    process.exit(2);
  }
  console.log(`Service healthy. Starting ramp.\n`);

  // Start background pollers
  // pollDockerStats is async — wrap to avoid unhandled rejections
  const dockerTimer = setInterval(() => void pollDockerStats(), DOCKER_INTERVAL);
  const metricsTimer = setInterval(() => void pollAppMetrics(), METRICS_INTERVAL);
  // Unref so they don't keep the process alive
  if (typeof dockerTimer.unref === "function") dockerTimer.unref();
  if (typeof metricsTimer.unref === "function") metricsTimer.unref();

  appendEv({
    ev: "ramp_start",
    t: Date.now(),
    config: {
      base: BASE,
      container: CONTAINER,
      requests_per_level: REQUESTS_PER_LEVEL,
      cooldown_s: COOLDOWN_S,
      max_concurrency: MAX_CONCURRENCY,
      prompt: PROMPT ? "custom" : "default",
    },
  });

  const t0 = Date.now();
  let baseIdx = 0;
  let levelIdx = 0;
  let stopReason: string | undefined;

  for (
    let concurrency = 1;
    concurrency <= MAX_CONCURRENCY;
    concurrency *= 2, levelIdx++
  ) {
    const levelStart = Date.now();
    appendEv({
      ev: "level_start",
      t: levelStart,
      concurrency,
      level_idx: levelIdx,
    });

    console.log(
      `Level ${levelIdx}: concurrency=${concurrency}, ` +
        `requests=${REQUESTS_PER_LEVEL}`,
    );

    const { ok, failed } = await driveLevel(
      concurrency,
      REQUESTS_PER_LEVEL,
      baseIdx,
    );

    const levelEnd = Date.now();
    appendEv({
      ev: "level_end",
      t: levelEnd,
      concurrency,
      level_idx: levelIdx,
      requests: REQUESTS_PER_LEVEL,
      ok,
      failed,
      duration_ms: levelEnd - levelStart,
    });

    console.log(
      `  → ok=${ok} failed=${failed} ` +
        `duration=${((levelEnd - levelStart) / 1000).toFixed(1)}s`,
    );

    baseIdx += REQUESTS_PER_LEVEL;

    // Check stop conditions
    const errorRate = failed / (ok + failed);
    if (errorRate > 0.5) {
      stopReason = "error_rate";
      console.log(`\n  STOP: error rate ${(errorRate * 100).toFixed(0)}% > 50%`);
      break;
    }

    // Check if container is still alive (retry a few times in case it's
    // busy with GC or finishing background work)
    const alive = await isHealthy(3);
    if (!alive) {
      stopReason = "container_unresponsive";
      console.log(
        `\n  STOP: container not responding after 3 retries (OOM killed or hung)`,
      );
      break;
    }

    // Cooldown between levels
    if (concurrency * 2 <= MAX_CONCURRENCY) {
      appendEv({
        ev: "cooldown_start",
        t: Date.now(),
        after_concurrency: concurrency,
      });
      console.log(`  Cooling down ${COOLDOWN_S}s...`);
      await new Promise((r) => setTimeout(r, COOLDOWN_S * 1000));
      appendEv({ ev: "cooldown_end", t: Date.now() });

      // Re-check health after cooldown
      const stillAlive = await isHealthy(3);
      if (!stillAlive) {
        stopReason = "container_unresponsive";
        console.log(`\n  STOP: container not responding after cooldown`);
        break;
      }
    }
  }

  if (!stopReason) {
    stopReason = "max_reached";
    console.log(`\n  Reached max concurrency=${MAX_CONCURRENCY}`);
  }

  // Stop pollers
  clearInterval(dockerTimer);
  clearInterval(metricsTimer);

  // Final metrics
  await new Promise((r) => setTimeout(r, 500));
  await pollDockerStats();
  await pollAppMetrics();

  const totalDuration = Date.now() - t0;
  appendEv({
    ev: "ramp_stop",
    t: Date.now(),
    reason: stopReason,
    last_concurrency: Math.pow(2, levelIdx) > MAX_CONCURRENCY
      ? MAX_CONCURRENCY
      : Math.pow(2, levelIdx),
    total_duration_ms: totalDuration,
  });

  console.log(`\nRamp complete: ${stopReason}`);
  console.log(`Total duration: ${(totalDuration / 1000).toFixed(1)}s`);
  console.log(`Output: ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
