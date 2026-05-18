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
    return {
      next: async (): Promise<IteratorResult<T>> => {
        while (true) {
          if (cursor < this.#items.length) {
            return { done: false, value: this.#items[cursor++] };
          }
          if (this.#closed) {
            return { done: true, value: undefined };
          }
          await new Promise<void>((resolve) => {
            this.#wakeups.add(resolve);
          });
        }
      },
      return: async () => ({ done: true, value: undefined }),
    };
  }
}
