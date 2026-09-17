import { v7 as uuidv7 } from "@langchain/core/utils/uuid";
import type { ThreadStream } from "../client/index.js";
import type { Run } from "../schema.js";
import { bindThreadConfig } from "./dispatch-config.js";
import {
  EMPTY_QUEUE,
  type QueueAdapter,
  type QueueRunsClient,
  type SubmissionQueueEntry,
  type SubmissionQueueSnapshot,
} from "./queue-adapter.js";
import { StreamStore } from "./store.js";
import type { StreamSubmitOptions } from "./types.js";

/** `runs.list()`'s `Run` type doesn't declare `kwargs` by default; it's an opt-in `select` field. */
type RunWithKwargs = Run & { kwargs?: { input?: unknown } };

/**
 * Backs "enqueue" with real, durable runs. An entry is a genuine
 * server-side pending run the instant `enqueue()` resolves.
 *
 * Selected automatically (see {@link SubmitCoordinator}'s constructor)
 * when the configured transport exposes a `serverQueue` capability.
 */
export class AgentServerQueueAdapter<
  StateType extends object = Record<string, unknown>,
> implements QueueAdapter<StateType> {
  readonly #runs: QueueRunsClient;
  readonly #assistantId: string;
  readonly #store: StreamStore<SubmissionQueueSnapshot<StateType>>;
  readonly #onError: (error: unknown) => void;
  readonly #getThread: (threadId: string) => Pick<ThreadStream, "onEvent">;
  /** One shared subscription for this adapter's lifetime, not one per run. */
  #unsubscribe: (() => void) | undefined;
  /** ids canceled while their create() was still in flight. */
  #pendingCancel = new Set<string>();
  #threadId: string | undefined;
  /** Guards against a stale hydrate() landing after a rapid thread-switch. */
  #hydrateGeneration = 0;
  /** Aborts in-flight bookkeeping `list()` calls on detach(); replaced (never reused) afterward. */
  #abortController = new AbortController();
  /** Handle for #refreshPending's pending retry, if any; cleared on detach(). */
  #refreshRetryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Lets enqueue() detect a "started" event during its own create(). */
  #startedEventCount = 0;

  constructor(
    runs: QueueRunsClient,
    assistantId: string,
    store: StreamStore<SubmissionQueueSnapshot<StateType>>,
    onError: (error: unknown) => void,
    getThread: (threadId: string) => Pick<ThreadStream, "onEvent">
  ) {
    this.#runs = runs;
    this.#assistantId = assistantId;
    this.#store = store;
    this.#onError = onError;
    this.#getThread = getThread;
  }

  async hydrate(threadId: string): Promise<void> {
    this.#threadId = threadId;
    this.#ensureWatching(threadId);
    const generation = ++this.#hydrateGeneration;
    // Baseline before asking: an entry assigned after this can't be in the response below.
    const knownAtRequestTime = this.#knownRunIds();
    let pending: RunWithKwargs[];
    try {
      pending = (await this.#runs.list(threadId, {
        status: "pending",
        // `list()` defaults to 10; a real cap would drop older entries.
        limit: 1000,
        // "kwargs" isn't part of the base `Run` shape returned by list();
        // it must be explicitly selected to get the original input back.
        select: ["run_id", "kwargs", "created_at", "multitask_strategy"],
        signal: this.#abortController.signal,
      })) as RunWithKwargs[];
    } catch (error) {
      // A generation mismatch means detach() aborted this on purpose.
      if (generation === this.#hydrateGeneration) this.#onError(error);
      return;
    }
    if (generation !== this.#hydrateGeneration) return; // superseded by a later hydrate()/detach()

    const remoteIds = new Set(pending.map((run) => run.run_id));
    this.#store.setState((current) => {
      const knownRunIds = new Set(
        current.flatMap((e) => (e.runId ? [e.runId] : []))
      );
      // Keep local entries as-is; never overwrite one with a Run
      // reconstruction, since a consumer may already be keying UI on
      // its id. Only reconstruct pending runs with no local counterpart
      // (enqueued elsewhere, or seen here for the first time).
      const stillValid = current.filter((e) =>
        this.#isStillQueued(e, remoteIds, knownAtRequestTime)
      );
      const newFromRemote = pending
        .filter((run) => !knownRunIds.has(run.run_id))
        .map((run) => this.#toEntry(run));
      return [
        ...newFromRemote,
        ...stillValid,
      ] as SubmissionQueueSnapshot<StateType>;
    });
  }

  /**
   * On a self-created thread, this can race the active run's own
   * `run.start` request that creates the thread row: if this
   * `runs.create()` reaches the server first, it may 404. The local
   * adapter has no such race (it never hits the server while queued).
   */
  async enqueue(
    threadId: string,
    values: Partial<StateType> | null | undefined,
    options: StreamSubmitOptions<StateType> | undefined
  ): Promise<void> {
    // A brand-new self-created thread may never be hydrated first.
    this.#threadId = threadId;
    this.#ensureWatching(threadId);
    const startedEventsBefore = this.#startedEventCount;
    const id = uuidv7();
    this.#store.setState((current) => [
      ...current,
      { id, values, options, createdAt: new Date() },
    ]);
    try {
      const run = await this.#runs.create(threadId, this.#assistantId, {
        input: values,
        config: bindThreadConfig(options?.config, threadId),
        metadata: options?.metadata,
        checkpointId: options?.forkFrom,
        multitaskStrategy: "enqueue",
      });
      if (this.#pendingCancel.delete(id)) {
        await this.#runs.cancel(threadId, run.run_id); // canceled while creating; don't resurrect it
        return;
      }
      this.#store.setState((current) =>
        current.map((entry) =>
          entry.id === id ? { ...entry, runId: run.run_id } : entry
        )
      );
      // A run may have started before we learned its id; re-check now.
      if (this.#startedEventCount !== startedEventsBefore) {
        void this.#refreshPending(threadId);
      }
    } catch (error) {
      this.#pendingCancel.delete(id); // avoid leaking a pending-cancel marker nothing will ever consult
      this.#store.setState((current) =>
        current.filter((entry) => entry.id !== id)
      );
      this.#onError(error);
      throw error;
    }
  }

  async cancel(id: string): Promise<boolean> {
    const entry = this.#store.getSnapshot().find((e) => e.id === id);
    if (!entry) return false;
    this.#store.setState((current) => current.filter((e) => e.id !== id));
    await this.#cancelEntry(entry);
    return true;
  }

  async clear(): Promise<void> {
    const entries = this.#store.getSnapshot();
    this.#store.setState(
      () => EMPTY_QUEUE as SubmissionQueueSnapshot<StateType>
    );
    // `allSettled`, not `all`: one failed cancel must not stop the rest
    // from being attempted, nor reject `clear()` itself.
    const results = await Promise.allSettled(
      entries.map((entry) => this.#cancelEntry(entry))
    );
    const failures = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected"
    );
    if (failures.length === 1) {
      this.#onError(failures[0].reason);
    } else if (failures.length > 1) {
      this.#onError(
        new AggregateError(
          failures.map((f) => f.reason),
          `${failures.length} of ${entries.length} queued runs failed to cancel`
        )
      );
    }
  }

  detach(): void {
    this.#hydrateGeneration++; // invalidate any in-flight hydrate() for this thread
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    // #pendingCancel is not cleared: dropping it would silently un-cancel an in-flight create().
    this.#threadId = undefined;
    this.#abortController.abort(); // stop any in-flight hydrate()/#refreshPending() list() call
    this.#abortController = new AbortController(); // an aborted controller can't be reused
    clearTimeout(this.#refreshRetryTimer); // a scheduled retry outliving detach() would target a stale thread
    this.#refreshRetryTimer = undefined;
  }

  async #cancelEntry(entry: SubmissionQueueEntry<StateType>): Promise<void> {
    if (entry.runId && this.#threadId) {
      await this.#runs.cancel(this.#threadId, entry.runId); // already real, idempotent
    } else {
      this.#pendingCancel.add(entry.id); // still being created; cancel on arrival
    }
  }

  /**
   * Lazily opens ONE subscription for this adapter's lifetime, not one
   * per run. `LifecycleEvent` carries no `run_id`, so a `"started"`
   * event triggers a `runs.list` re-check instead of a direct match.
   */
  #ensureWatching(threadId: string): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#getThread(threadId).onEvent((event) => {
      if (event.method !== "lifecycle") return;
      if (event.params.data.event !== "started") return;
      this.#startedEventCount++;
      void this.#refreshPending(threadId);
    });
  }

  /**
   * Re-lists pending runs and drops any queue entry no longer reported
   * pending: it's running now. Retried once after a network failure
   * before surfacing an error — otherwise a single blip would leave a
   * now-running entry stuck showing "queued" until the next promotion
   * or a manual hydrate.
   */
  async #refreshPending(threadId: string, attempt = 0): Promise<void> {
    if (this.#store.getSnapshot().length === 0) return; // nothing left to refresh
    const generation = this.#hydrateGeneration;
    const knownAtRequestTime = this.#knownRunIds(); // same reasoning as hydrate()
    try {
      const pending = await this.#runs.list(threadId, {
        status: "pending",
        limit: 1000, // list() defaults to 10; see the matching note in hydrate()
        signal: this.#abortController.signal,
      });
      if (generation !== this.#hydrateGeneration) return; // superseded; thread id is stale
      const stillPendingIds = new Set(pending.map((run) => run.run_id));
      this.#store.setState((current) =>
        current.filter((entry) =>
          this.#isStillQueued(entry, stillPendingIds, knownAtRequestTime)
        )
      );
    } catch (error) {
      if (generation !== this.#hydrateGeneration) return; // detach() aborted this on purpose
      if (attempt < 1) {
        this.#refreshRetryTimer = setTimeout(() => {
          this.#refreshRetryTimer = undefined;
          void this.#refreshPending(threadId, attempt + 1);
        }, 2000);
        return;
      }
      this.#onError(error);
    }
  }

  #toEntry(run: RunWithKwargs): SubmissionQueueEntry<StateType> {
    return {
      id: run.run_id,
      runId: run.run_id,
      values: run.kwargs?.input as Partial<StateType> | null | undefined,
      createdAt: new Date(run.created_at),
    };
  }

  #knownRunIds(): Set<string> {
    return new Set(
      this.#store.getSnapshot().flatMap((e) => (e.runId ? [e.runId] : []))
    );
  }

  /** Shared by hydrate() and #refreshPending(): is a list() response grounds to evict this entry? */
  #isStillQueued(
    entry: SubmissionQueueEntry<StateType>,
    stillPendingIds: Set<string>,
    knownAtRequestTime: Set<string>
  ): boolean {
    return (
      !entry.runId ||
      stillPendingIds.has(entry.runId) ||
      !knownAtRequestTime.has(entry.runId)
    );
  }
}
