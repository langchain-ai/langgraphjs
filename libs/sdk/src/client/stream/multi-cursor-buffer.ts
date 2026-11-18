/**
 * Multi-cursor buffer that supports independent async iterators over a
 * shared append-only log of items.  Each `for await` loop gets its own
 * cursor starting at position 0, so late consumers still see all
 * previously buffered items.
 *
 * Mirrors the in-process multi-cursor buffering used by `GraphRunStream`.
 */
export class MultiCursorBuffer<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #wakeups = new Set<() => void>();
  #closed = false;

  push(item: T): void {
    this.#items.push(item);
    for (const cb of this.#wakeups) cb();
    this.#wakeups.clear();
  }

  close(): void {
    this.#closed = true;
    for (const cb of this.#wakeups) cb();
    this.#wakeups.clear();
  }

  get length(): number {
    return this.#items.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    let cursor = 0;
    let finished = false;
    const pending = new Set<() => void>();
    return {
      next: async (): Promise<IteratorResult<T>> => {
        while (true) {
          if (finished) return { done: true, value: undefined };
          if (cursor < this.#items.length) {
            return { done: false, value: this.#items[cursor++] };
          }
          if (this.#closed) {
            finished = true;
            return { done: true, value: undefined };
          }
          await new Promise<void>((resolve) => {
            const wake = () => {
              this.#wakeups.delete(wake);
              pending.delete(wake);
              resolve();
            };
            pending.add(wake);
            this.#wakeups.add(wake);
          });
        }
      },
      return: async () => {
        finished = true;
        for (const wake of pending) wake();
        return { done: true, value: undefined };
      },
    };
  }
}
