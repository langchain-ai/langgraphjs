/**
 * EventLog — append-only log with multiple independent async cursors.
 *
 * All projections in the v2 streaming API are backed by EventLog instances.
 * Multiple `for await` loops can run concurrently over the same log without
 * interfering — each iterator maintains its own cursor position.
 *
 * Items are retained for the lifetime of the log (no eviction).  A
 * bounded-buffer variant may be substituted for very long-running agents.
 */

/**
 * An append-only, async-iterable event log that supports multiple independent
 * cursors.  Producers {@link EventLog.push | push} items and signal completion
 * via {@link EventLog.close | close} or {@link EventLog.fail | fail}.
 * Consumers obtain cursors with {@link EventLog.iterate | iterate} or
 * {@link EventLog.toAsyncIterable | toAsyncIterable}.
 *
 * @typeParam T - The type of items stored in the log.
 */
export class EventLog<T> {
  #items: T[] = [];
  #waiters: Array<() => void> = [];
  #done = false;
  #error: unknown;

  /**
   * Append an item to the log and wake any waiting cursors.
   *
   * @param item - The item to append.
   */
  push(item: T): void {
    this.#items.push(item);
    this.#wake();
  }

  /**
   * Mark the log as complete.  All active and future iterators will finish
   * after yielding any remaining items.
   */
  close(): void {
    this.#done = true;
    this.#wake();
  }

  /**
   * Mark the log as failed.  All active and future iterators will throw
   * {@link err} after yielding any remaining items.
   *
   * @param err - The error to propagate to consumers.
   */
  fail(err: unknown): void {
    this.#error = err;
    this.#done = true;
    this.#wake();
  }

  /**
   * Returns an async iterator starting at position {@link startAt}.
   * Each call returns an independent cursor so multiple consumers can
   * iterate the same log concurrently.
   *
   * Uses arrow functions to lexically bind `this`, giving the returned
   * iterator object access to native `#private` fields.
   *
   * @param startAt - Zero-based index to begin reading from.
   * @returns A new {@link AsyncIterator} over log items.
   */
  iterate(startAt = 0): AsyncIterator<T> {
    let cursor = startAt;
    return {
      next: async (): Promise<IteratorResult<T>> => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (cursor < this.#items.length) {
            return { value: this.#items[cursor++], done: false };
          }
          if (this.#done) {
            if (this.#error) throw this.#error;
            return { value: undefined as unknown as T, done: true };
          }
          await new Promise<void>((resolve) => this.#waiters.push(resolve));
        }
      },
    };
  }

  /**
   * Creates an {@link AsyncIterable} backed by this log, starting from
   * {@link startAt}.  Convenience wrapper so callers can use `for await`.
   *
   * @param startAt - Zero-based index to begin reading from.
   * @returns A new {@link AsyncIterable} over log items.
   */
  toAsyncIterable(startAt = 0): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]: () => this.iterate(startAt),
    };
  }

  /**
   * The number of items currently in the log.
   */
  get size(): number {
    return this.#items.length;
  }

  /**
   * Whether the log has been closed or failed.
   */
  get done(): boolean {
    return this.#done;
  }

  #wake(): void {
    const waiters = this.#waiters.splice(0);
    for (const w of waiters) w();
  }
}
