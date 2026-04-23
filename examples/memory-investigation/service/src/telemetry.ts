/**
 * Process-level memory telemetry for the service.
 *
 *   - PeriodicSampler: runs a 100 ms sampler in the background. Every
 *     sample is appended to an in-memory ring buffer and ALSO emitted to
 *     stdout as a structured JSONL line tagged ev="sample" so an external
 *     collector can tail the container logs.
 *
 *   - instrumentRequest: wraps a request handler with pre/post memory
 *     snapshots + peak-during-request tracking. Emits one JSONL line per
 *     request tagged ev="request".
 *
 * Keep this module dependency-free beyond node:* builtins so the service
 * boot overhead stays low.
 */
import * as v8 from "node:v8";
import { randomUUID } from "node:crypto";

export interface MemSnap {
  t_ms: number;
  heap_used: number;
  heap_total: number;
  external: number;
  array_buffers: number;
  rss: number;
  v8_total_heap: number;
  v8_used_heap: number;
  v8_heap_size_limit: number;
  v8_malloced: number;
  v8_peak_malloced: number;
}

const T0 = Date.now();

export function snap(): MemSnap {
  const mu = process.memoryUsage();
  const h = v8.getHeapStatistics() as unknown as {
    total_heap_size: number;
    used_heap_size: number;
    heap_size_limit: number;
    malloced_memory: number;
    peak_malloced_memory: number;
  };
  return {
    t_ms: Date.now() - T0,
    heap_used: mu.heapUsed,
    heap_total: mu.heapTotal,
    external: mu.external,
    array_buffers: mu.arrayBuffers,
    rss: mu.rss,
    v8_total_heap: h.total_heap_size,
    v8_used_heap: h.used_heap_size,
    v8_heap_size_limit: h.heap_size_limit,
    v8_malloced: h.malloced_memory,
    v8_peak_malloced: h.peak_malloced_memory,
  };
}

function emit(record: Record<string, unknown>) {
  // JSONL to stdout. Docker captures this; we can tail -f or pipe to file.
  process.stdout.write(JSON.stringify(record) + "\n");
}

// ─── Periodic sampler ────────────────────────────────────────────────
// 10_000 samples = ~1000s at 100 ms, plenty for long-running requests.
const RING_CAPACITY = 10_000;
const samples: MemSnap[] = [];
let samplerTimer: ReturnType<typeof setInterval> | null = null;

export function startPeriodicSampler(intervalMs = 100) {
  if (samplerTimer) return;
  samplerTimer = setInterval(() => {
    const s = snap();
    samples.push(s);
    if (samples.length > RING_CAPACITY) samples.shift();
    emit({ ev: "sample", ...s });
  }, intervalMs);
  // Unref so the sampler doesn't keep the process alive.
  if (samplerTimer && typeof samplerTimer.unref === "function") {
    samplerTimer.unref();
  }
  emit({ ev: "sampler_start", interval_ms: intervalMs, t_ms: Date.now() - T0 });
}

export function getRecentSamples(sinceMs?: number): MemSnap[] {
  if (sinceMs === undefined) return [...samples];
  return samples.filter((s) => s.t_ms >= sinceMs);
}

// ─── Per-request instrumentation ─────────────────────────────────────
export interface RequestStats {
  request_id: string;
  t_start_ms: number;
  t_end_ms: number;
  duration_ms: number;
  pre: MemSnap;
  post: MemSnap;
  peak_heap: number;
  peak_rss: number;
  peak_external: number;
}

/**
 * Wrap an async request handler. Records pre/post snapshots, a peak
 * observed during execution (sampled from the periodic sampler OR spot
 * checked on completion — whichever we have), and emits a JSONL record.
 */
export async function instrumentRequest<T>(
  label: string,
  handler: (requestId: string) => Promise<T>,
): Promise<{ result: T; stats: RequestStats }> {
  const requestId = randomUUID();
  const pre = snap();
  emit({
    ev: "request_start",
    request_id: requestId,
    label,
    t_ms: pre.t_ms,
    pre,
  });
  let result: T;
  try {
    result = await handler(requestId);
  } catch (err) {
    const post = snap();
    emit({
      ev: "request_error",
      request_id: requestId,
      label,
      t_ms: post.t_ms,
      post,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  const post = snap();
  // Peak across the request's time window — filter by t_ms rather than
  // index so this is robust even if the ring buffer wrapped.
  const windowSamples = samples.filter(
    (s) => s.t_ms >= pre.t_ms && s.t_ms <= post.t_ms,
  );
  const peak_heap = Math.max(
    post.heap_used,
    pre.heap_used,
    ...windowSamples.map((s) => s.heap_used),
  );
  const peak_rss = Math.max(
    post.rss,
    pre.rss,
    ...windowSamples.map((s) => s.rss),
  );
  const peak_external = Math.max(
    post.external,
    pre.external,
    ...windowSamples.map((s) => s.external),
  );

  const stats: RequestStats = {
    request_id: requestId,
    t_start_ms: pre.t_ms,
    t_end_ms: post.t_ms,
    duration_ms: post.t_ms - pre.t_ms,
    pre,
    post,
    peak_heap,
    peak_rss,
    peak_external,
  };
  emit({ ev: "request", label, ...stats });
  return { result, stats };
}

export function T0_MS(): number {
  return T0;
}
