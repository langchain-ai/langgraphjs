import type { QueueResult } from "./types.js";

/**
 * Minimal async queue used to bridge push-based transport callbacks into
 * async-iterable consumers.
 *
 * @typeParam T - Value type delivered by the queue.
 */
export class AsyncQueue<T> {
  private readonly values: T[] = [];

  private readonly waiters: Array<(result: QueueResult<T>) => void> = [];

  private readonly rejecters: Array<(error: Error) => void> = [];

  private closed = false;

  private error: Error | null = null;

  /**
   * Pushes a value into the queue or resolves the next pending consumer.
   *
   * @param value - Value to enqueue.
   */
  push(value: T): void {
    if (this.closed) {
      return;
    }

    const waiter = this.waiters.shift();
    this.rejecters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }

    this.values.push(value);
  }

  /**
   * Closes the queue and optionally rejects pending consumers with an error.
   *
   * @param error - Optional error used to reject pending and future reads.
   */
  close(error?: unknown): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.error =
      error == null
        ? null
        : // oxlint-disable-next-line no-instanceof/no-instanceof
          error instanceof Error
          ? error
          : new Error(String(error));

    if (this.error) {
      for (const rejecter of this.rejecters.splice(0)) {
        rejecter(this.error);
      }
      this.waiters.length = 0;
      return;
    }

    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
    this.rejecters.length = 0;
  }

  /**
   * Resolves with the next queued value or waits for a future one.
   *
   * @returns The next queue result for the consumer.
   */
  async shift(): Promise<QueueResult<T>> {
    if (this.values.length > 0) {
      return { done: false, value: this.values.shift() as T };
    }

    if (this.error) {
      throw this.error;
    }

    if (this.closed) {
      return { done: true, value: undefined };
    }

    return await new Promise<QueueResult<T>>((resolve, reject) => {
      this.waiters.push(resolve);
      this.rejecters.push(reject);
    });
  }
}
