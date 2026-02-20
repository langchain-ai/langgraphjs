import { IterableReadableStream } from "@langchain/core/utils/stream";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StreamMode, StreamOutputMap } from "./types.js";

// [namespace, streamMode, payload]
export type StreamChunk = [string[], StreamMode, unknown];

type StreamCheckpointsOutput<StreamValues> = StreamOutputMap<
  "checkpoints",
  false,
  StreamValues,
  unknown,
  string,
  unknown,
  unknown,
  undefined
>;

type AnyStreamOutput = StreamOutputMap<
  StreamMode[],
  true,
  unknown,
  unknown,
  string,
  unknown,
  unknown,
  undefined
>;

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
    // Prevent pushing to a closed stream to avoid race condition errors
    if (this._closed || !this.controller) {
      // Silently drop chunks when stream is closed - this is expected behavior
      // when async operations try to push after stream termination
      return;
    }

    try {
      // Forward chunk to passthrough function if provided
      this.passthroughFn?.(chunk);

      // Attempt to enqueue the chunk to the underlying stream
      this.controller.enqueue(chunk);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof (error as { message?: unknown }).message === "string" &&
        (error as { message: string }).message.includes(
          "Controller is already closed"
        )
      ) {
        // Silently ignore - this is expected during stream closure with concurrent pushes
        return;
      }

      // Re-throw any other unexpected errors to maintain proper error reporting
      throw error;
    }
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

function _stringifyAsDict(obj: unknown) {
  return JSON.stringify(obj, function (key: string | number, value: unknown) {
    const rawValue = this[key];
    if (
      rawValue != null &&
      typeof rawValue === "object" &&
      "toDict" in rawValue &&
      typeof rawValue.toDict === "function"
    ) {
      const { type, data } = rawValue.toDict();
      return { ...data, type };
    }

    return value;
  });
}

function _serializeError(error: unknown) {
  // eslint-disable-next-line no-instanceof/no-instanceof
  if (error instanceof Error) {
    return { error: error.name, message: error.message };
  }
  return { error: "Error", message: JSON.stringify(error) };
}

function _isRunnableConfig(
  config: unknown
): config is RunnableConfig & { configurable: Record<string, unknown> } {
  if (typeof config !== "object" || config == null) return false;
  return (
    "configurable" in config &&
    typeof config.configurable === "object" &&
    config.configurable != null
  );
}

function _extractCheckpointFromConfig(
  config: RunnableConfig | null | undefined
) {
  if (!_isRunnableConfig(config) || !config.configurable.thread_id) {
    return null;
  }

  return {
    thread_id: config.configurable.thread_id,
    checkpoint_ns: config.configurable.checkpoint_ns || "",
    checkpoint_id: config.configurable.checkpoint_id || null,
    checkpoint_map: config.configurable.checkpoint_map || null,
  };
}

function _serializeConfig(config: unknown) {
  if (_isRunnableConfig(config)) {
    const configurable = Object.fromEntries(
      Object.entries(config.configurable).filter(
        ([key]) => !key.startsWith("__")
      )
    );

    const newConfig = { ...config, configurable };
    delete newConfig.callbacks;
    return newConfig;
  }

  return config;
}

function _serializeCheckpoint(payload: StreamCheckpointsOutput<unknown>) {
  const result: Record<string, unknown> = {
    ...payload,
    checkpoint: _extractCheckpointFromConfig(payload.config),
    parent_checkpoint: _extractCheckpointFromConfig(payload.parentConfig),

    config: _serializeConfig(payload.config),
    parent_config: _serializeConfig(payload.parentConfig),

    tasks: payload.tasks.map((task) => {
      if (_isRunnableConfig(task.state)) {
        const checkpoint = _extractCheckpointFromConfig(task.state);
        if (checkpoint != null) {
          const cloneTask: Record<string, unknown> = { ...task, checkpoint };
          delete cloneTask.state;
          return cloneTask;
        }
      }

      return task;
    }),
  };

  delete result.parentConfig;
  return result;
}

export function toEventStream(stream: AsyncGenerator) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueueChunk = (sse: {
        id?: string;
        event: string;
        data: unknown;
      }) => {
        controller.enqueue(
          encoder.encode(
            `event: ${sse.event}\ndata: ${_stringifyAsDict(sse.data)}\n\n`
          )
        );
      };

      try {
        for await (const payload of stream) {
          const [ns, mode, chunk] = payload as AnyStreamOutput;

          let data: unknown = chunk;
          if (mode === "debug") {
            const debugChunk = chunk;

            if (debugChunk.type === "checkpoint") {
              data = {
                ...debugChunk,
                payload: _serializeCheckpoint(debugChunk.payload),
              };
            }
          }

          if (mode === "checkpoints") {
            data = _serializeCheckpoint(chunk);
          }

          const event = ns?.length ? `${mode}|${ns.join("|")}` : mode;
          enqueueChunk({ event, data });
        }
      } catch (error) {
        enqueueChunk({ event: "error", data: _serializeError(error) });
      }

      controller.close();
    },
  });
}
