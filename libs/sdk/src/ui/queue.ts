import type { SubmitOptions, CustomSubmitOptions } from "./types.js";

/**
 * A single queued submission entry.
 *
 * In LangGraph Platform mode, entries correspond to pending server-side runs
 * created via `client.runs.create()` with `multitaskStrategy: "enqueue"`.
 * In custom transport mode, entries represent locally queued submissions that
 * will be replayed FIFO once the active stream completes.
 */
export interface QueueEntry<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  OptionsType = SubmitOptions<StateType> | CustomSubmitOptions<StateType>
> {
  /**
   * Queue entry identifier.
   *
   * In LangGraph Platform mode, this is the server run ID. In custom
   * transport mode, this is a locally generated queue item ID.
   */
  id: string;

  /** The state update values passed to submit() */
  values: Partial<StateType> | null | undefined;

  /** The submit options passed to submit() */
  options?: OptionsType;

  /** Timestamp when the entry was created */
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

  /** Cancel and remove a specific queued entry. Returns true if found. */
  cancel: (id: string) => Promise<boolean>;

  /** Clear all queued entries. */
  clear: () => Promise<void>;
}

/**
 * Tracks pending queued submissions.
 *
 * Uses the same subscribe/getSnapshot pattern as StreamManager to integrate
 * with framework-specific reactivity systems.
 */
export class PendingRunsTracker<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  OptionsType = SubmitOptions<StateType> | CustomSubmitOptions<StateType>
> {
  private pending: QueueEntry<StateType, OptionsType>[] = [];

  private listeners = new Set<() => void>();

  /**
   * Add a pending run entry.
   */
  add(entry: QueueEntry<StateType, OptionsType>): void {
    this.pending.push(entry);
    this.notifyListeners();
  }

  /**
   * Remove and return the next pending entry (FIFO).
   */
  shift(): QueueEntry<StateType, OptionsType> | undefined {
    const entry = this.pending.shift();
    if (entry) this.notifyListeners();
    return entry;
  }

  /**
   * Remove a specific entry by ID.
   * @returns true if the entry was found and removed.
   */
  remove = (id: string): boolean => {
    const index = this.pending.findIndex((e) => e.id === id);
    if (index === -1) return false;
    this.pending.splice(index, 1);
    this.notifyListeners();
    return true;
  };

  /**
   * Remove all entries from the tracker.
   * @returns The removed entries.
   */
  removeAll = (): QueueEntry<StateType, OptionsType>[] => {
    if (this.pending.length === 0) return [];
    const entries = [...this.pending];
    this.pending = [];
    this.notifyListeners();
    return entries;
  };

  /** Read-only snapshot of all pending entries. */
  get entries(): ReadonlyArray<QueueEntry<StateType, OptionsType>> {
    return this.pending;
  }

  /** Number of pending entries. */
  get size(): number {
    return this.pending.length;
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Snapshot token for useSyncExternalStore compatibility. */
  getSnapshot = (): number => {
    return this.pending.length;
  };

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
