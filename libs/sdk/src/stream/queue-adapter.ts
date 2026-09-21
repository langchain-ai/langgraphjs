import type { RunsClient } from "../client/index.js";
import type { StreamSubmitOptions } from "./types.js";

/**
 * A transport's capability to back `"enqueue"` with real, durable
 * server-side runs. Present unconditionally on the built-in transport
 * (it always carries a `client.runs`); a custom `AgentServerAdapter`
 * opts in by implementing it. See {@link AgentServerQueueAdapter}.
 */
export type ServerQueueCapability = Pick<
  RunsClient,
  "create" | "list" | "cancel"
>;

/**
 * No {@link ServerQueueCapability}: `"enqueue"` stays a client-only,
 * in-memory defer. See {@link LocalQueueAdapter}.
 */
export type LocalQueueCapability = undefined;

/** A single queued submission. */
export interface SubmissionQueueEntry<
  StateType extends object = Record<string, unknown>,
> {
  /** Stable id minted on enqueue (uuidv7) or the server run id for a hydrated entry. */
  readonly id: string;
  /** Server run id, once accepted. Absent while a dispatch is still in flight. */
  readonly runId?: string;
  /** Original submit input, narrowed to the partial state shape. */
  readonly values: Partial<StateType> | null | undefined;
  /** Original submit options, minus the strategy slot which is reset on drain. */
  readonly options?: StreamSubmitOptions<StateType>;
  /** Wall-clock timestamp at enqueue. */
  readonly createdAt: Date;
}

/**
 * Read-only snapshot of the queue. The queue store hands this out
 * directly; consumers must not mutate the array.
 */
export type SubmissionQueueSnapshot<
  StateType extends object = Record<string, unknown>,
> = ReadonlyArray<SubmissionQueueEntry<StateType>>;

/** Frozen empty queue, reused for referential stability across resets. */
export const EMPTY_QUEUE: SubmissionQueueSnapshot<never> = Object.freeze([]);

/**
 * Pluggable backing for `useStream`'s "enqueue" multitask strategy. Owns
 * how a deferred submission is tracked while it waits its turn: where
 * it's recorded, how it's hydrated on load, how it learns a run started,
 * and how it's cancelled. {@link SubmitCoordinator} only delegates to
 * this for the `"enqueue"` case; see {@link LocalQueueAdapter}
 * (`queue-adapter-local.ts`) and {@link AgentServerQueueAdapter}
 * (`queue-adapter-agent-server.ts`) for the two implementations.
 *
 * Not exported from the package. Which implementation backs a given
 * call is decided by whether the transport exposes a
 * {@link ServerQueueCapability} (see `AgentServerAdapter.serverQueue`
 * in `client/stream/transport.ts`) — derived from the transport itself,
 * never a class a consumer picks between directly.
 */
export interface QueueAdapter<
  StateType extends object = Record<string, unknown>,
> {
  /**
   * Populate the queue store from whatever this adapter considers the
   * source of truth: a real `runs.list` hydrate, or a no-op for the
   * local adapter. Called once, when the controller first binds to a
   * thread.
   */
  hydrate(threadId: string): Promise<void>;

  /**
   * Record a deferred submission. Resolves once it's safe to consider
   * *accepted*: for the server-backed adapter, once the server has
   * durably recorded it.
   */
  enqueue(
    threadId: string,
    values: Partial<StateType> | null | undefined,
    options: StreamSubmitOptions<StateType> | undefined
  ): Promise<void>;

  /**
   * Cancel one queued entry by its {@link SubmissionQueueEntry.id}.
   * Idempotent: cancelling an entry that's already started running or
   * was already removed resolves `false` rather than throwing.
   */
  cancel(id: string): Promise<boolean>;

  /** Cancel and remove every currently-queued entry. */
  clear(): Promise<void>;

  /**
   * Release whatever this adapter is watching. Called once, on
   * controller disposal or thread rebind.
   */
  detach(): void;

  /**
   * Called whenever the active run settles (nothing currently in
   * flight). Only meaningful for adapters that gate dispatch on
   * client-side timing: {@link LocalQueueAdapter} uses this to drain
   * its next entry via `dispatch`. {@link AgentServerQueueAdapter}
   * omits it entirely: the server's own scheduler decides when the next
   * pending run starts and the adapter only observes it.
   */
  onIdle?(
    dispatch: (
      values: unknown,
      options: StreamSubmitOptions<StateType> | undefined
    ) => Promise<void>
  ): void;
}
