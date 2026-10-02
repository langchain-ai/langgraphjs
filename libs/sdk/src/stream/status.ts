import type { RootSnapshot } from "./types.js";

/**
 * High-level lifecycle phase of a stream, derived from the root
 * snapshot. A single readable value to drive UI instead of juggling
 * the {@link RootSnapshot.isLoading} / {@link RootSnapshot.error}
 * booleans by hand.
 *
 *   - `"idle"`       — no run in flight and no error.
 *   - `"submitting"` — a run has been dispatched but has not started
 *                      running yet (the optimistic in-flight window).
 *   - `"streaming"`  — the run is actively running / emitting events.
 *   - `"error"`      — the last run or hydration attempt errored.
 *
 * Hydration (`isThreadLoading`) is intentionally orthogonal and left
 * as its own flag.
 */
export type StreamStatus = "idle" | "submitting" | "streaming" | "error";

/**
 * Derive the {@link StreamStatus} from the parts of a root snapshot
 * that describe run lifecycle. Errors take precedence; otherwise an
 * in-flight run is `"streaming"` once it has begun running and
 * `"submitting"` until then.
 */
export function deriveStreamStatus(
  snapshot: Pick<RootSnapshot, "isLoading" | "isRunning" | "error">
): StreamStatus {
  if (snapshot.error !== undefined) return "error";
  if (!snapshot.isLoading) return "idle";
  return snapshot.isRunning ? "streaming" : "submitting";
}
