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

// Circular buffer — O(1) insert, no Array.shift() copying.
// `ringBuffer` is pre-allocated to RING_CAPACITY slots. `ringLength`
// tracks how many are actually filled (grows until RING_CAPACITY, then
// stays fixed). `ringHead` points to the oldest entry (the next slot
// to be overwritten once full).
const ringBuffer: MemSnap[] = new Array<MemSnap>(RING_CAPACITY);
let ringHead = 0; // index of oldest entry
let ringLength = 0; // number of entries currently stored
let samplerTimer: ReturnType<typeof setInterval> | null = null;

function ringPush(s: MemSnap) {
  if (ringLength < RING_CAPACITY) {
    ringBuffer[ringLength] = s;
    ringLength++;
  } else {
    ringBuffer[ringHead] = s;
    ringHead = (ringHead + 1) % RING_CAPACITY;
  }
}

export function startPeriodicSampler(intervalMs = 100) {
  if (samplerTimer) return;
  samplerTimer = setInterval(() => {
    const s = snap();
    ringPush(s);
    emit({ ev: "sample", ...s });
  }, intervalMs);
  // Unref so the sampler doesn't keep the process alive.
  if (samplerTimer && typeof samplerTimer.unref === "function") {
    samplerTimer.unref();
  }
  emit({ ev: "sampler_start", interval_ms: intervalMs, t_ms: Date.now() - T0 });
}

export function getRecentSamples(sinceMs?: number): MemSnap[] {
  const result: MemSnap[] = [];
  for (let i = 0; i < ringLength; i++) {
    const idx = (ringHead + i) % RING_CAPACITY;
    const s = ringBuffer[idx];
    if (sinceMs === undefined || s.t_ms >= sinceMs) {
      result.push(s);
    }
  }
  return result;
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
 * Compute peak values from a window of samples using reduce() instead
 * of Math.max(...spread) to avoid call stack limits on large windows.
 */
function computePeaks(
  pre: MemSnap,
  post: MemSnap,
  startMs: number,
  endMs: number,
): { peak_heap: number; peak_rss: number; peak_external: number } {
  let peak_heap = Math.max(pre.heap_used, post.heap_used);
  let peak_rss = Math.max(pre.rss, post.rss);
  let peak_external = Math.max(pre.external, post.external);

  // Walk the ring buffer without allocating a filtered copy.
  if (ringLength > 0) {
    let idx = ringHead;
    for (let i = 0; i < ringLength; i++) {
      const s = ringBuffer[idx];
      if (s.t_ms >= startMs && s.t_ms <= endMs) {
        if (s.heap_used > peak_heap) peak_heap = s.heap_used;
        if (s.rss > peak_rss) peak_rss = s.rss;
        if (s.external > peak_external) peak_external = s.external;
      }
      idx = (idx + 1) % RING_CAPACITY;
    }
  }

  return { peak_heap, peak_rss, peak_external };
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
  const peaks = computePeaks(pre, post, pre.t_ms, post.t_ms);

  const stats: RequestStats = {
    request_id: requestId,
    t_start_ms: pre.t_ms,
    t_end_ms: post.t_ms,
    duration_ms: post.t_ms - pre.t_ms,
    pre,
    post,
    ...peaks,
  };
  emit({ ev: "request", label, ...stats });
  return { result, stats };
}

/**
 * Wrap an SSE ReadableStream<Uint8Array> so that when the stream fully
 * drains (or errors), we capture a post-execution memory snapshot. This
 * solves the problem that `runStream()` returns the ReadableStream
 * immediately — the real memory pressure happens during iteration.
 *
 * Returns a new ReadableStream that passes through all bytes unchanged
 * but emits telemetry events at start, end, and on error.
 */
export function instrumentSSEStream(
  label: string,
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const requestId = randomUUID();
  const pre = snap();
  let bytesSent = 0;

  emit({
    ev: "stream_start",
    request_id: requestId,
    label,
    t_ms: pre.t_ms,
    pre,
  });

  const reader = stream.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          const post = snap();
          const peaks = computePeaks(pre, post, pre.t_ms, post.t_ms);
          const stats: RequestStats = {
            request_id: requestId,
            t_start_ms: pre.t_ms,
            t_end_ms: post.t_ms,
            duration_ms: post.t_ms - pre.t_ms,
            pre,
            post,
            ...peaks,
          };
          emit({
            ev: "stream_end",
            label,
            bytes_sent: bytesSent,
            ...stats,
          });
          return;
        }
        bytesSent += value.byteLength;
        controller.enqueue(value);
      } catch (err) {
        const post = snap();
        emit({
          ev: "stream_error",
          request_id: requestId,
          label,
          t_ms: post.t_ms,
          post,
          bytes_sent: bytesSent,
          error: err instanceof Error ? err.message : String(err),
        });
        controller.error(err);
      }
    },
    cancel() {
      reader.cancel();
      const post = snap();
      emit({
        ev: "stream_cancel",
        request_id: requestId,
        label,
        t_ms: post.t_ms,
        post,
        bytes_sent: bytesSent,
      });
    },
  });
}

export function T0_MS(): number {
  return T0;
}
