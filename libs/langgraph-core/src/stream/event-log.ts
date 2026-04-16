/**
 * EventLog — append-only log with multiple independent async cursors.
 *
 * All projections in the v2 streaming API are backed by EventLog instances.
 * Multiple `for await` loops can run concurrently over the same log without
 * interfering — each iterator maintains its own cursor position.
 *
 * Items are retained for the lifetime of the log (no eviction).  A
 * bounded-buffer variant may be substituted for very long-running agents.
 *
 * Events are **not** flushed between runs.  Each `createGraphRunStream()`
 * call creates a fresh `StreamMux`, which in turn instantiates new
 * `EventLog` instances for its event and discovery logs.  Once the run
 * completes, `close()` or `fail()` seals the log permanently — there is
 * no reset.  The entire object tree becomes eligible for GC once all
 * consumers finish iterating and release their references.
 */

/**
 * An append-only, async-iterable event log that supports multiple independent
 * cursors.  Producers {@link EventLog.push | push} items and signal completion
 * via {@link EventLog.close | close} or {@link EventLog.fail | fail}.
 * Consumers obtain cursors with {@link EventLog.iterate | iterate} or
 * {@link EventLog.toAsyncIterable | toAsyncIterable}.
 *
 * @typeParam T - The type of items stored in the log.
 *
 * @example Working — multiple concurrent consumers each see every item:
 * ```ts
 * const log = new EventLog<number>();
 *
 * // Two independent consumers over the same log
 * const iterA = log.toAsyncIterable();
 * const iterB = log.toAsyncIterable();
 *
 * log.push(1);
 * log.push(2);
 * log.close();
 *
 * for await (const n of iterA) console.log("A:", n); // A: 1, A: 2
 * for await (const n of iterB) console.log("B:", n); // B: 1, B: 2
 * ```
 *
 * This is how `GraphRunStream` exposes `.values` and `.messages` as
 * separate projections over the same event flow — each projection gets
 * its own cursor and reads independently.
 *
 * @example Not working — a plain `AsyncGenerator` can only be consumed once:
 * ```ts
 * async function* generate() { yield 1; yield 2; }
 * const gen = generate();
 *
 * for await (const n of gen) console.log("A:", n); // A: 1, A: 2
 * for await (const n of gen) console.log("B:", n); // (nothing — already exhausted)
 * ```
 *
 * With a plain generator the second consumer gets nothing.  `EventLog`
 * retains all items, so late or concurrent cursors never miss events.
 *
 * @example Working — late subscribers catch up from any position:
 * ```ts
 * const log = new EventLog<string>();
 * log.push("a");
 * log.push("b");
 *
 * // Subscriber joins after items have already been pushed
 * const late = log.toAsyncIterable();
 * log.push("c");
 * log.close();
 *
 * for await (const s of late) console.log(s); // "a", "b", "c"
 * ```
 *
 * @example Working — errors propagate to all active iterators:
 * ```ts
 * const log = new EventLog<number>();
 * const iterA = log.toAsyncIterable();
 * const iterB = log.toAsyncIterable();
 *
 * log.push(1);
 * log.fail(new Error("graph crashed"));
 *
 * // Both consumers see the item, then receive the error
 * for await (const n of iterA) {} // yields 1, then throws
 * for await (const n of iterB) {} // yields 1, then throws
 * ```
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
   * Returns the item at the given zero-based index.
   *
   * @param index - Zero-based position in the log.
   * @returns The item at that position.
   * @throws {RangeError} If the index is out of bounds.
   */
  get(index: number): T {
    if (index < 0 || index >= this.#items.length) {
      throw new RangeError(
        `EventLog index ${index} out of bounds (size=${this.#items.length})`
      );
    }
    return this.#items[index];
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
