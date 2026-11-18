import type { ThreadState } from "../schema.js";

/**
 * The thread states loads last read, by thread, so a thread opened again
 * shows at once while it is read again (`threadCache`). One cache serves
 * every engine of an app, also those of thread pages that come and go.
 *
 * It holds what its user could read: share it only between engines reading
 * the same server as the same user, and {@link clear} it when they sign out.
 * Threads past `maxBytes` push out the ones opened least recently. A thread's
 * size is the length of its strings, which make up most of a read.
 */
export class ThreadCache {
  readonly #maxBytes: number;

  readonly #threads = new Map<
    string,
    { states: ThreadState[]; bytes: number }
  >();

  #bytes = 0;

  #generation = 0;

  constructor(options: { maxBytes?: number } = {}) {
    this.#maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  }

  /** The states last read of the thread, which becomes the one opened last. */
  get<StateType = Record<string, unknown>>(
    threadId: string
  ): ThreadState<StateType>[] | undefined {
    const entry = this.#threads.get(threadId);
    if (entry == null) return undefined;
    this.#threads.delete(threadId);
    this.#threads.set(threadId, entry);
    return entry.states as ThreadState<StateType>[];
  }

  /**
   * Changes on every {@link clear}. An engine reads it as a read begins and
   * passes it to {@link set}, so a read that lands after a sign-out stays out.
   */
  get generation(): number {
    return this.#generation;
  }

  set(
    threadId: string,
    states: ThreadState<unknown>[],
    generation = this.#generation
  ): void {
    if (generation !== this.#generation) return;
    this.delete(threadId);
    const bytes = sizeOf(states);
    if (states.length === 0 || bytes > this.#maxBytes) return;
    this.#threads.set(threadId, { states: states as ThreadState[], bytes });
    this.#bytes += bytes;
    for (const [id, entry] of this.#threads) {
      if (this.#bytes <= this.#maxBytes) break;
      this.#threads.delete(id);
      this.#bytes -= entry.bytes;
    }
  }

  delete(threadId: string): void {
    const entry = this.#threads.get(threadId);
    if (entry == null) return;
    this.#threads.delete(threadId);
    this.#bytes -= entry.bytes;
  }

  clear(): void {
    this.#threads.clear();
    this.#bytes = 0;
    this.#generation += 1;
  }

  /** The sizes of the threads held, together. */
  get bytes(): number {
    return this.#bytes;
  }
}

function sizeOf(value: unknown): number {
  let size = 0;
  const seen = new WeakSet<object>();
  const stack = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === "string") size += item.length;
    else if (item != null && typeof item === "object" && !seen.has(item)) {
      seen.add(item);
      for (const child of Object.values(item)) stack.push(child);
    }
  }
  return size;
}
