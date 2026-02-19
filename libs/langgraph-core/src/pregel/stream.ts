import { IterableReadableStream } from "@langchain/core/utils/stream";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StreamMode, StreamOutputMap } from "./types.js";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { Serialized } from "@langchain/core/load/serializable";
import { TAG_HIDDEN } from "../constants.js";

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

type ToolRunInfo = {
  ns: string[];
  metadata: Record<string, any>;
  toolCallId?: string;
  toolName: string;
  input: any;
};

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

/**
 * A callback handler that implements stream_mode=tools.
 * Emits on_tool_start, on_tool_partial, on_tool_end, on_tool_error events.
 */
export class StreamToolsHandler extends BaseCallbackHandler {
  name = "StreamToolsHandler";

  streamFn: (streamChunk: StreamChunk) => void;

  runs: Record<string, ToolRunInfo | undefined> = {};

  constructor(streamFn: (streamChunk: StreamChunk) => void) {
    super();
    this.streamFn = streamFn;
  }

  handleToolStart(
    _tool: Serialized,
    input: string,
    runId: string,
    _parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string
  ) {
    if (!metadata || (tags && tags.includes(TAG_HIDDEN))) return;

    const ns = (metadata.langgraph_checkpoint_ns as string)?.split("|") ?? [];
    const info: ToolRunInfo = {
      ns,
      metadata: { tags, ...metadata },
      toolCallId: metadata.toolCallId as string | undefined,
      toolName: runName ?? "unknown",
      input,
    };
    this.runs[runId] = info;

    this.streamFn([
      ns,
      "tools",
      {
        event: "on_tool_start",
        toolCallId: info.toolCallId,
        name: info.toolName,
        input,
      },
    ]);
  }

  handleToolStream(
    chunk: unknown,
    runId: string,
    _parentRunId?: string,
    _tags?: string[]
  ) {
    const info = this.runs[runId];
    if (!info) return;

    this.streamFn([
      info.ns,
      "tools",
      {
        event: "on_tool_partial",
        toolCallId: info.toolCallId,
        name: info.toolName,
        data: chunk,
      },
    ]);
  }

  handleToolEnd(output: any, runId: string) {
    const info = this.runs[runId];
    delete this.runs[runId];
    if (!info) return;

    this.streamFn([
      info.ns,
      "tools",
      {
        event: "on_tool_end",
        toolCallId: info.toolCallId,
        name: info.toolName,
        output,
      },
    ]);
  }

  handleToolError(err: any, runId: string) {
    const info = this.runs[runId];
    delete this.runs[runId];
    if (!info) return;

    this.streamFn([
      info.ns,
      "tools",
      {
        event: "on_tool_error",
        toolCallId: info.toolCallId,
        name: info.toolName,
        error: err,
      },
    ]);
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
