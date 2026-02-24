import type { SubmitOptions, CustomSubmitOptions } from "./types.js";

/**
 * A single queued submission entry, storing the state update values
 * and submit options that will be passed to submit() when dequeued.
 */
export interface QueueEntry<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  OptionsType = SubmitOptions<StateType> | CustomSubmitOptions<StateType>
> {
  /** Unique identifier for this queue entry, used for cancellation */
  id: string;

  /** The state update to submit (same as the first argument to submit()) */
  values: Partial<StateType> | null | undefined;

  /** The submit options (same as the second argument to submit()) */
  options?: OptionsType;

  /** Timestamp when the entry was added to the queue */
  createdAt: Date;
}

/**
 * Reactive interface exposed to framework consumers for observing
 * and managing the submission queue.
 */
export interface QueueInterface<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  OptionsType = SubmitOptions<StateType> | CustomSubmitOptions<StateType>
> {
  /** Read-only array of pending queue entries */
  readonly entries: ReadonlyArray<QueueEntry<StateType, OptionsType>>;

  /** Number of pending entries */
  readonly size: number;

  /** Remove a specific entry from the queue by ID. Returns true if found and removed. */
  cancel: (id: string) => boolean;

  /** Remove all entries from the queue. */
  clear: () => void;
}

/**
 * Client-side submission queue that stores pending state updates
 * and drains them sequentially when the agent becomes idle.
 *
 * Uses the same subscribe/getSnapshot pattern as StreamManager
 * to integrate with framework-specific reactivity systems.
 */
export class SubmitQueue<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  OptionsType = SubmitOptions<StateType> | CustomSubmitOptions<StateType>
> {
  private pending: QueueEntry<StateType, OptionsType>[] = [];

  private listeners = new Set<() => void>();

  private drainFn:
    | ((entry: QueueEntry<StateType, OptionsType>) => Promise<void>)
    | null = null;

  private draining = false;

  private stopped = false;

  /** Register the function that processes a dequeued entry. */
  setDrainHandler(
    fn: (entry: QueueEntry<StateType, OptionsType>) => Promise<void>
  ): void {
    this.drainFn = fn;
  }

  /**
   * Add a new entry to the queue.
   * @returns The unique entry ID.
   */
  enqueue(
    values: Partial<StateType> | null | undefined,
    options?: OptionsType
  ): string {
    const id = crypto.randomUUID();
    this.pending.push({ id, values, options, createdAt: new Date() });
    this.notifyListeners();
    return id;
  }

  /**
   * Remove a specific entry from the queue by ID.
   * @returns true if the entry was found and removed.
   */
  cancel = (id: string): boolean => {
    const index = this.pending.findIndex((e) => e.id === id);
    if (index === -1) return false;
    this.pending.splice(index, 1);
    this.notifyListeners();
    return true;
  };

  /** Remove all entries from the queue. */
  clear = (): void => {
    if (this.pending.length === 0) return;
    this.pending = [];
    this.stopped = false;
    this.notifyListeners();
  };

  /** Read-only snapshot of all pending entries. */
  get entries(): ReadonlyArray<QueueEntry<StateType, OptionsType>> {
    return this.pending;
  }

  /** Number of pending entries. */
  get size(): number {
    return this.pending.length;
  }

  /**
   * Dequeue the next entry and process it via the drain handler.
   * No-op if the queue is empty, no handler is set, or already draining.
   *
   * @param onQueueError - "continue" (default): skip failed entry and keep draining.
   *                       "stop": halt the queue on error.
   */
  drain(onQueueError: "continue" | "stop" = "continue"): void {
    if (this.pending.length === 0 || !this.drainFn || this.draining) return;
    if (this.stopped) return;

    const entry = this.pending.shift()!;
    this.draining = true;
    this.notifyListeners();

    this.drainFn(entry)
      .catch(() => {
        if (onQueueError === "stop") {
          this.stopped = true;
        }
      })
      .finally(() => {
        this.draining = false;
      });
  }

  /** Whether the queue is currently draining an entry. */
  get isDraining(): boolean {
    return this.draining;
  }

  /** Subscribe to queue state changes. Returns an unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Snapshot token for useSyncExternalStore compatibility. */
  getSnapshot = (): number => {
    return this.pending.length + (this.draining ? 0.5 : 0);
  };

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
