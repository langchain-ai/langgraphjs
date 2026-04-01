/**
 * `ReadableStream` wrapper that also exposes the async iterator protocol in
 * environments where the native stream implementation does not.
 *
 * @typeParam T - Value type produced by the stream.
 */
export class IterableReadableStream<T>
  extends ReadableStream<T>
  implements AsyncIterable<T>
{
  public reader!: ReadableStreamDefaultReader<T>;

  /**
   * Lazily acquires a reader for the wrapped stream.
   */
  ensureReader() {
    if (!this.reader) {
      this.reader = this.getReader();
    }
  }

  /**
   * Reads the next value from the stream.
   *
   * @returns The next iterator result from the stream.
   */
  async next(): Promise<IteratorResult<T>> {
    this.ensureReader();
    try {
      const result = await this.reader.read();
      if (result.done) {
        this.reader.releaseLock();
        return {
          done: true,
          value: undefined,
        };
      }

      return {
        done: false,
        value: result.value,
      };
    } catch (error) {
      this.reader.releaseLock();
      throw error;
    }
  }

  /**
   * Cancels iteration and closes the stream reader.
   *
   * @returns A completed iterator result.
   */
  async return(): Promise<IteratorResult<T>> {
    this.ensureReader();
    if (this.locked) {
      const cancelPromise = this.reader.cancel();
      this.reader.releaseLock();
      await cancelPromise;
    }
    return { done: true, value: undefined };
  }

  /**
   * Cancels iteration and rethrows the supplied error.
   *
   * @param error - Error to throw after cleanup.
   * @returns This method always throws after cleanup.
   */
  async throw(error: unknown): Promise<IteratorResult<T>> {
    this.ensureReader();
    if (this.locked) {
      const cancelPromise = this.reader.cancel();
      this.reader.releaseLock();
      await cancelPromise;
    }
    throw error;
  }

  /**
   * Disposes the iterator by delegating to `return()`.
   *
   * @returns A promise that resolves after iterator cleanup completes.
   */
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore Not present in Node 18 types, required in latest Node 22
  async [Symbol.asyncDispose]() {
    await this.return();
  }

  /**
   * Returns the stream instance as its own async iterator.
   *
   * @returns The async iterator for this stream.
   */
  [Symbol.asyncIterator]() {
    return this;
  }

  /**
   * Wraps an existing `ReadableStream` in an async-iterable facade.
   *
   * @param stream - Stream to wrap.
   * @returns An async-iterable readable stream.
   */
  static fromReadableStream<T>(stream: ReadableStream<T>) {
    const reader = stream.getReader();
    return new IterableReadableStream<T>({
      start(controller) {
        return pump();

        function pump(): Promise<T | undefined> {
          return reader.read().then(({ done, value }) => {
            if (done) {
              controller.close();
              return;
            }
            controller.enqueue(value);
            return pump();
          });
        }
      },
      cancel() {
        reader.releaseLock();
      },
    });
  }
}
