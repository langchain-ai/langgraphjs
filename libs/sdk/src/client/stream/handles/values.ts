import type { Event, ValuesEvent } from "@langchain/protocol";
import type { SubscriptionHandle } from "../index.js";

/**
 * Async iterable handle for `values` events with a per-run output promise.
 *
 * Mirrors the in-process `run.values` + `run.output` pattern:
 * - Iterate to receive each intermediate state snapshot as it arrives.
 * - `await handle.output` to get the final state value when the current
 *   run completes (or is interrupted).
 *
 * Subscriptions are session-scoped: when a run reaches a terminal
 * lifecycle state the iterator pauses (returns `done: true`) but the
 * handle stays alive.  Re-entering `for await` on the same handle
 * picks up the next run's events automatically.  The `output` promise
 * resolves per-run and resets when the source resumes.
 *
 * Note: this class intentionally does NOT implement `PromiseLike` because
 * it is returned from an `async` method (`session.subscribe("values")`).
 * If it were thenable, `await session.subscribe("values")` would trigger
 * double thenable unwrapping and block forever.
 */
export class ValuesSubscriptionHandle implements AsyncIterable<unknown> {
  readonly params;
  readonly subscriptionId: string;
  private readonly source: SubscriptionHandle<Event>;
  private readonly queue: unknown[] = [];
  private readonly waiters: Array<
    (value: IteratorResult<unknown>) => void
  > = [];
  private sourcePump?: Promise<void>;
  private closed = false;
  private paused = false;

  private lastValue: unknown = undefined;
  private resolveOutput!: (value: unknown) => void;
  private outputPromise: Promise<unknown>;

  constructor(source: SubscriptionHandle<Event>) {
    this.source = source;
    this.subscriptionId = source.subscriptionId;
    this.params = source.params;
    this.outputPromise = new Promise<unknown>((resolve) => {
      this.resolveOutput = resolve;
    });
    this.start();
  }

  /**
   * Promise that resolves with the final (last) state value when the
   * current run completes or is interrupted.  Resets automatically
   * when the next run begins.
   */
  get output(): Promise<unknown> {
    return this.outputPromise;
  }

  private start(): void {
    if (this.sourcePump) return;
    this.sourcePump = (async () => {
      while (!this.closed) {
        for await (const event of this.source) {
          if (event.method !== "values") continue;
          const data = (event as ValuesEvent).params.data;
          this.lastValue = data;
          const waiter = this.waiters.shift();
          if (waiter) {
            waiter({ done: false, value: data });
          } else {
            this.queue.push(data);
          }
        }

        if (this.source.isPaused) {
          this.paused = true;
          this.resolveOutput(this.lastValue);
          while (this.waiters.length > 0) {
            this.waiters.shift()?.({ done: true, value: undefined });
          }
          await this.source.waitForResume();
          if (this.closed) break;
          this.paused = false;
          this.lastValue = undefined;
          this.outputPromise = new Promise<unknown>((resolve) => {
            this.resolveOutput = resolve;
          });
          continue;
        }

        break;
      }

      this.closed = true;
      this.resolveOutput(this.lastValue);
      while (this.waiters.length > 0) {
        this.waiters.shift()?.({ done: true, value: undefined });
      }
    })();
  }

  async unsubscribe(): Promise<void> {
    this.closed = true;
    this.resolveOutput(this.lastValue);
    await this.source.unsubscribe();
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async () => {
        if (this.queue.length > 0) {
          return { done: false, value: this.queue.shift()! };
        }
        if (this.closed || this.paused) {
          return { done: true, value: undefined };
        }
        return await new Promise<IteratorResult<unknown>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: async () => {
        await this.unsubscribe();
        return { done: true, value: undefined };
      },
    };
  }
}
