import type { SubmitOptions, CustomSubmitOptions } from "./types.js";

/**
 * A single queued submission entry representing a server-side pending run.
 * Each entry corresponds to a run created on the server via
 * `client.runs.create()` with `multitaskStrategy: "enqueue"`.
 */
export interface QueueEntry<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  OptionsType = SubmitOptions<StateType> | CustomSubmitOptions<StateType>,
> {
  /** Server-side run ID (from `client.runs.create()`) */
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
 * and managing the server-side submission queue.
 */
export interface QueueInterface<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  OptionsType = SubmitOptions<StateType> | CustomSubmitOptions<StateType>,
> {
  /** Read-only array of pending queue entries */
  readonly entries: ReadonlyArray<QueueEntry<StateType, OptionsType>>;

  /** Number of pending entries */
  readonly size: number;

  /** Cancel a specific pending run by its server run ID. Returns true if found and cancelled. */
  cancel: (id: string) => Promise<boolean>;

  /** Cancel all pending runs on the server and clear the queue. */
  clear: () => Promise<void>;
}

/**
 * Tracks pending server-side runs created via `multitaskStrategy: "enqueue"`.
 *
 * Uses the same subscribe/getSnapshot pattern as StreamManager
 * to integrate with framework-specific reactivity systems.
 */
export class PendingRunsTracker<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  OptionsType = SubmitOptions<StateType> | CustomSubmitOptions<StateType>,
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
   * @returns The removed entries (for server-side cancellation).
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
