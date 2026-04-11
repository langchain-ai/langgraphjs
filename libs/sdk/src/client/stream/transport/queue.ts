import type { QueueResult } from "./types.js";

export class AsyncQueue<T> {
  private readonly values: T[] = [];

  private readonly waiters: Array<(result: QueueResult<T>) => void> = [];

  private readonly rejecters: Array<(error: Error) => void> = [];

  private closed = false;

  private error: Error | null = null;

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
