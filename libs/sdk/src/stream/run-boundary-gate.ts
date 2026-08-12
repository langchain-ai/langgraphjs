/**
 * Run-scoped filter for protocol v2 replay.
 *
 * New SSE subscriptions replay the thread tape from `seq=0`. Connection-
 * local `seq` cannot tell "old run" from "current run". This gate uses
 * durable `run_id` (envelope field, with a `synth:<run_id>:…` fallback)
 * so submit settle, loading, and values application ignore pre-boundary
 * replay from older runs.
 *
 * Modes:
 * - `idle` — no local submit / bound run; accept everything (legacy).
 * - `expecting` — submit started, `run.start` not yet resolved; buffer
 *   terminals/values that carry a run id for flush on bind.
 * - `bound` — expected run id known; accept only matching events (or,
 *   on old servers without run id, events after a post-bind `running`).
 */
import type { Event, LifecycleEvent } from "@langchain/protocol";

const TERMINAL_EVENTS = new Set(["completed", "failed", "interrupted"]);

export type RunBoundaryMode = "idle" | "expecting" | "bound";

export interface RunBoundFlush {
  readonly terminals: Event[];
  readonly values: Event[];
}

/**
 * Read durable run identity from a protocol event.
 *
 * Prefers the envelope `run_id` field. Falls back to parsing
 * `synth:<run_id>:…` event ids minted by Agent Server for synthetic
 * lifecycle frames — not a public contract, only a compatibility path
 * until all servers stamp the envelope field.
 */
export function extractEventRunId(event: {
  run_id?: unknown;
  event_id?: unknown;
}): string | undefined {
  if (typeof event.run_id === "string" && event.run_id.length > 0) {
    return event.run_id;
  }
  if (typeof event.event_id === "string") {
    const match = /^synth:([^:]+):/.exec(event.event_id);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function lifecycleStatus(event: Event): string | undefined {
  if (event.method !== "lifecycle") return undefined;
  const data = (event as LifecycleEvent).params.data as { event?: string };
  return typeof data?.event === "string" ? data.event : undefined;
}

export class RunBoundaryGate {
  #mode: RunBoundaryMode = "idle";
  #expectedRunId: string | undefined;
  /**
   * When bound without a concrete run id (HITL resume via `input.respond`,
   * which does not return `run_id`), require a root `running` before
   * terminals/values count — same idea as `#awaitResumedRunTerminal`.
   */
  #legacyRequireRunning = false;
  #sawRunningForExpected = false;
  #bufferedTerminals: Event[] = [];
  #bufferedValues: Event[] = [];

  get mode(): RunBoundaryMode {
    return this.#mode;
  }

  get expectedRunId(): string | undefined {
    return this.#expectedRunId;
  }

  /**
   * Enter expecting mode at the start of a local submit.
   * Until {@link onRunBound}, root terminals and values are not applied.
   */
  onSubmitStart(): void {
    this.#mode = "expecting";
    this.#expectedRunId = undefined;
    this.#legacyRequireRunning = false;
    this.#sawRunningForExpected = false;
    this.#bufferedTerminals = [];
    this.#bufferedValues = [];
  }

  /**
   * Enter a run-id-less boundary for `input.respond` resumes.
   * `input.respond` does not return a run id, so we accept events after
   * the next root `running` (and ignore pre-running terminals).
   */
  onResumeStart(): void {
    this.#mode = "bound";
    this.#expectedRunId = undefined;
    this.#legacyRequireRunning = true;
    this.#sawRunningForExpected = false;
    this.#bufferedTerminals = [];
    this.#bufferedValues = [];
  }

  /**
   * Bind to the run accepted by `run.start` (or hydrate of an active run).
   *
   * @returns Buffered root events whose run id matches, for waiters /
   *   projection to apply (fast path before command ack).
   */
  onRunBound(runId: string): RunBoundFlush {
    if (this.#mode === "bound" && this.#expectedRunId === runId) {
      // Idempotent re-bind (submit coordinator may notify twice).
      return { terminals: [], values: [] };
    }
    this.#expectedRunId = runId;
    this.#mode = "bound";
    this.#legacyRequireRunning = false;
    const terminals = this.#bufferedTerminals.filter(
      (event) => extractEventRunId(event) === runId
    );
    const values = this.#bufferedValues.filter(
      (event) => extractEventRunId(event) === runId
    );
    this.#bufferedTerminals = [];
    this.#bufferedValues = [];
    return { terminals, values };
  }

  /** Clear on thread teardown. */
  reset(): void {
    this.#mode = "idle";
    this.#expectedRunId = undefined;
    this.#legacyRequireRunning = false;
    this.#sawRunningForExpected = false;
    this.#bufferedTerminals = [];
    this.#bufferedValues = [];
  }

  /**
   * Clear after the bound local run settles so later replay / re-attach
   * falls back to idle acceptance until the next submit.
   */
  onRunSettled(): void {
    this.reset();
  }

  /**
   * Whether a root lifecycle event should drive loading / submit settle.
   */
  acceptLifecycle(event: Event): boolean {
    if (this.#mode === "idle") return true;

    const status = lifecycleStatus(event);
    if (status == null) return true;

    const runId = extractEventRunId(event);

    if (this.#mode === "expecting") {
      if (TERMINAL_EVENTS.has(status) && runId != null) {
        this.#bufferUnique(this.#bufferedTerminals, event);
      }
      // Drop `running` from unknown runs until bound — loading must not
      // flicker on replayed prior-run lifecycle.
      return false;
    }

    // bound
    if (this.#expectedRunId != null) {
      if (runId != null) {
        if (runId !== this.#expectedRunId) return false;
        if (status === "running") this.#sawRunningForExpected = true;
        return true;
      }
      // Legacy servers: no envelope / synth run id — require a `running`
      // after bind before terminals count.
      if (status === "running") {
        this.#sawRunningForExpected = true;
        return true;
      }
      if (TERMINAL_EVENTS.has(status)) {
        return this.#sawRunningForExpected;
      }
      return true;
    }

    // Resume without run id (`onResumeStart`): mirror
    // `#awaitResumedRunTerminal` — only `interrupted` waits for a
    // post-resume `running`; `completed` / `failed` settle immediately.
    if (this.#legacyRequireRunning) {
      if (status === "running") {
        this.#sawRunningForExpected = true;
        return true;
      }
      if (status === "interrupted") {
        return this.#sawRunningForExpected;
      }
      return true;
    }

    return true;
  }

  /**
   * Whether a root `values` snapshot should update projected state.
   * Hydrated `getState()` remains authoritative until the current run
   * produces snapshots.
   */
  acceptValues(event: Event): boolean {
    if (this.#mode === "idle") return true;

    const runId = extractEventRunId(event);

    if (this.#mode === "expecting") {
      if (runId != null) {
        this.#bufferUnique(this.#bufferedValues, event);
      }
      return false;
    }

    if (this.#expectedRunId != null) {
      if (runId != null) {
        return runId === this.#expectedRunId;
      }
      return this.#sawRunningForExpected;
    }

    if (this.#legacyRequireRunning) {
      return this.#sawRunningForExpected;
    }

    return true;
  }

  #bufferUnique(buffer: Event[], event: Event): void {
    const eventId = event.event_id;
    if (
      typeof eventId === "string" &&
      buffer.some((entry) => entry.event_id === eventId)
    ) {
      return;
    }
    buffer.push(event);
  }
}
