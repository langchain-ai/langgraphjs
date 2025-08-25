import type { RunnableConfig } from "@langchain/core/runnables";
import type { StreamEvent } from "@langchain/core/tracers/log_stream";
import type { StreamMode, StreamOutputMap } from "../pregel/types.js";
import type {
  AnyPregelLike,
  ExtraTypeBag,
  InferLangGraphEventStream,
} from "./types.infer.js";

type StreamCheckpointsOutput<StreamValues> = StreamOutputMap<
  "checkpoints",
  false,
  StreamValues,
  unknown,
  string,
  unknown
>;

const serialiseAsDict = <T>(obj: T): T => {
  return JSON.parse(
    JSON.stringify(obj, function (key: string | number, value: unknown) {
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
    })
  );
};

const serializeError = (error: unknown) => {
  // eslint-disable-next-line no-instanceof/no-instanceof
  if (error instanceof Error) {
    return { error: error.name, message: error.message };
  }
  return { error: "Error", message: JSON.stringify(error) };
};

const isRunnableConfig = (
  config: unknown
): config is RunnableConfig & { configurable: Record<string, unknown> } => {
  if (typeof config !== "object" || config == null) return false;
  return (
    "configurable" in config &&
    typeof config.configurable === "object" &&
    config.configurable != null
  );
};

const extractCheckpointFromConfig = (
  config: RunnableConfig | null | undefined
) => {
  if (!isRunnableConfig(config) || !config.configurable.thread_id) {
    return null;
  }

  return {
    thread_id: config.configurable.thread_id,
    checkpoint_ns: config.configurable.checkpoint_ns || "",
    checkpoint_id: config.configurable.checkpoint_id || null,
    checkpoint_map: config.configurable.checkpoint_map || null,
  };
};

const serializeConfig = (config: unknown) => {
  if (isRunnableConfig(config)) {
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
};

function serializeCheckpoint(payload: StreamCheckpointsOutput<unknown>) {
  const result: Record<string, unknown> = {
    ...payload,
    checkpoint: extractCheckpointFromConfig(payload.config),
    parent_checkpoint: extractCheckpointFromConfig(payload.parentConfig),

    config: serializeConfig(payload.config),
    parent_config: serializeConfig(payload.parentConfig),

    tasks: payload.tasks.map((task) => {
      if (isRunnableConfig(task.state)) {
        const checkpoint = extractCheckpointFromConfig(task.state);
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

/**
 * Converts a `graph.streamEvents()` output into a LangGraph Platform compatible event stream.
 * @experimental Does not follow semver.
 *
 * @param events
 */
export async function* toLangGraphEventStream<
  TGraph extends AnyPregelLike,
  TExtra extends ExtraTypeBag = ExtraTypeBag
>(
  events: AsyncIterable<StreamEvent> | Promise<AsyncIterable<StreamEvent>>
): AsyncGenerator<InferLangGraphEventStream<TGraph, TExtra>> {
  let rootRunId: string | undefined;

  try {
    for await (const event of await events) {
      if (event.event === "on_chain_start" && rootRunId == null) {
        rootRunId = event.run_id;
      }
      if (event.tags?.includes("langsmith:hidden")) continue;
      if (event.event === "on_chain_stream" && event.run_id === rootRunId) {
        if (!Array.isArray(event.data.chunk)) {
          continue;
        }

        type AnyStreamOutput = StreamOutputMap<
          StreamMode[],
          true,
          unknown,
          unknown,
          string,
          unknown
        >;

        const [ns, mode, chunk] = (
          event.data.chunk.length === 3
            ? event.data.chunk
            : [null, ...event.data.chunk]
        ) as AnyStreamOutput;

        // Listen for debug events and capture checkpoint
        let data: unknown = chunk;
        if (mode === "debug") {
          const debugChunk = chunk;

          if (debugChunk.type === "checkpoint") {
            data = {
              ...debugChunk,
              payload: serializeCheckpoint(debugChunk.payload),
            };
          }
        }

        if (mode === "checkpoints") {
          data = serializeCheckpoint(chunk);
        }

        // This needs to be done for LC.js V0 messages, since they
        // by default serialize using the verbose Serializable protocol.
        data = serialiseAsDict(data);

        yield {
          event: ns?.length ? `${mode}|${ns.join("|")}` : mode,
          data,
        } as InferLangGraphEventStream<TGraph, TExtra>;
      }
    }
  } catch (error) {
    yield { event: "error", data: serializeError(error) };
  }
}

/**
 * Converts a `graph.streamEvents()` output into a LangGraph Platform compatible Web Response.
 * @experimental Does not follow semver.
 */
export function toLangGraphEventStreamResponse(options: {
  status?: number;
  statusText?: string;
  headers?: Headers | Record<string, string>;
  stream: AsyncIterable<StreamEvent> | Promise<AsyncIterable<StreamEvent>>;
}) {
  const headers = new Headers({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  if (options.headers) {
    if (
      "forEach" in options.headers &&
      typeof options.headers.forEach === "function"
    ) {
      options.headers.forEach((v, k) => headers.set(k, v));
    } else {
      Object.entries(options.headers).map(([k, v]) => headers.set(k, v));
    }
  }

  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          for await (const { event, data } of toLangGraphEventStream(
            options.stream
          )) {
            controller.enqueue(`event: ${event}\n`);
            controller.enqueue(`data: ${JSON.stringify(data)}\n\n`);
          }
        } finally {
          controller.close();
        }
      },
    }),
    { headers, status: options.status, statusText: options.statusText }
  );
}
