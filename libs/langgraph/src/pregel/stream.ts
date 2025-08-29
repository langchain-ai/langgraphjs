import { IterableReadableStream } from "@langchain/core/utils/stream";
import { StreamMode } from "./types.js";

// [namespace, streamMode, payload]
export type StreamChunk = [string[], StreamMode, unknown];

/**
 * A wrapper around an IterableReadableStream that allows for aborting the stream when
 * {@link cancel} is called.
 */
export class IterableReadableStreamWithAbortSignal<
  T
> extends IterableReadableStream<T> {
  protected _abortController: AbortController;

  protected _innerReader: ReadableStreamDefaultReader<T>;

  /**
   * @param readableStream - The stream to wrap.
   * @param abortController - The abort controller to use. Optional. One will be created if not provided.
   */
  constructor(
    readableStream: ReadableStream<T>,
    abortController?: AbortController
  ) {
    const reader = readableStream.getReader();
    const ac = abortController ?? new AbortController();
    super({
      start(controller: ReadableStreamDefaultController<T>) {
        return pump();
        function pump(): Promise<T | undefined> {
          return reader.read().then(({ done, value }) => {
            // When no more data needs to be consumed, close the stream
            if (done) {
              controller.close();
              return;
            }
            // Enqueue the next data chunk into our target stream
            controller.enqueue(value);
            return pump();
          });
        }
      },
    });
    this._abortController = ac;
    this._innerReader = reader;
  }

  /**
   * Aborts the stream, abandoning any pending operations in progress. Calling this triggers an
   * {@link AbortSignal} that is propagated to the tasks that are producing the data for this stream.
   * @param reason - The reason for aborting the stream. Optional.
   */
  override async cancel(reason?: unknown) {
    this._abortController.abort(reason);
    this._innerReader.releaseLock();
  }

  /**
   * The {@link AbortSignal} for the stream. Aborted when {@link cancel} is called.
   */
  get signal() {
    return this._abortController.signal;
  }
}

export class IterableReadableWritableStream extends IterableReadableStream<StreamChunk> {
  modes: Set<StreamMode>;

  private controller: ReadableStreamDefaultController;

  private passthroughFn?: (chunk: StreamChunk) => void;

  private _closed: boolean = false;

  get closed() {
    return this._closed;
  }

  constructor(params: {
    passthroughFn?: (chunk: StreamChunk) => void;
    modes: Set<StreamMode>;
  }) {
    let streamControllerPromiseResolver: (
      controller: ReadableStreamDefaultController
    ) => void;
    const streamControllerPromise: Promise<ReadableStreamDefaultController> =
      new Promise<ReadableStreamDefaultController>((resolve) => {
        streamControllerPromiseResolver = resolve;
      });

    super({
      start: (controller) => {
        streamControllerPromiseResolver!(controller);
      },
    });

    // .start() will always be called before the stream can be interacted
    // with anyway
    void streamControllerPromise.then((controller) => {
      this.controller = controller;
    });

    this.passthroughFn = params.passthroughFn;
    this.modes = params.modes;
  }

  push(chunk: StreamChunk) {
    this.passthroughFn?.(chunk);
    this.controller.enqueue(chunk);
  }

  close() {
    try {
      this.controller.close();
    } catch (e) {
      // pass
    } finally {
      this._closed = true;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error(e: any) {
    this.controller.error(e);
  }
}
