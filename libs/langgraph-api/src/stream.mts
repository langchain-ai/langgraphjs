import { BaseMessageChunk, isBaseMessage } from "@langchain/core/messages";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import type {
  BaseCheckpointSaver,
  LangGraphRunnableConfig,
  CheckpointMetadata,
  Interrupt,
  StateSnapshot,
} from "@langchain/langgraph";
import {
  convertToProtocolEvent,
  STREAM_EVENTS_V3_MODES,
} from "@langchain/langgraph/web";
import type { Pregel } from "@langchain/langgraph/pregel";
import { Client as LangSmithClient, getDefaultProjectName } from "langsmith";
import { getLangGraphCommand } from "./command.mjs";
import { PROTOCOL_STREAM_RUN_KEY } from "./protocol/constants.mjs";
import type {
  Checkpoint as ProtocolCheckpoint,
  SourceStreamEvent,
} from "./protocol/types.mjs";
import { checkLangGraphSemver } from "./semver/index.mjs";
import type { Checkpoint, Run, RunnableConfig } from "./storage/types.mjs";
import {
  runnableConfigToCheckpoint,
  taskRunnableConfigToCheckpoint,
} from "./utils/runnableConfig.mjs";

type LangGraphStreamMode = Pregel<any, any>["streamMode"][number];

interface DebugTask {
  id: string;
  name: string;
  result?: unknown;
  error?: unknown;
  interrupts: Interrupt[];
  state?: RunnableConfig | StateSnapshot;
  path?: [string, ...(string | number)[]];
}

interface DebugChunk<Name extends string, Payload> {
  type: Name;
  timestamp: number;
  step: number;
  payload: Payload;
}

interface DebugCheckpoint {
  config: RunnableConfig;
  parentConfig: RunnableConfig | undefined;
  values: unknown;
  metadata: CheckpointMetadata;
  next: string[];
  tasks: DebugTask[];
}

type LangGraphDebugChunk =
  | DebugChunk<"checkpoint", DebugCheckpoint>
  | DebugChunk<"task_result", DebugTask>;

const isRunnableConfig = (config: unknown): config is RunnableConfig => {
  if (typeof config !== "object" || config == null) return false;
  return (
    "configurable" in config &&
    typeof config.configurable === "object" &&
    config.configurable != null
  );
};

type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

export type StreamCheckpoint = Prettify<
  Omit<DebugCheckpoint, "parentConfig"> & {
    parent_config: DebugCheckpoint["parentConfig"];
  }
>;

export type StreamTaskResult = Prettify<
  Omit<DebugTask, "state"> & {
    state?: StateSnapshot;
    checkpoint?: Checkpoint;
  }
>;

function preprocessDebugCheckpointTask(task: DebugTask): StreamTaskResult {
  if (
    !isRunnableConfig(task.state) ||
    !taskRunnableConfigToCheckpoint(task.state)
  ) {
    return task as unknown as StreamTaskResult;
  }

  const cloneTask: Record<string, unknown> = { ...task };
  cloneTask.checkpoint = taskRunnableConfigToCheckpoint(task.state);
  delete cloneTask.state;

  return cloneTask as StreamTaskResult;
}

const isConfigurablePresent = (
  config: unknown
): config is {
  [key: string]: unknown;
  callbacks?: unknown;
  configurable: { [key: string]: unknown };
} =>
  typeof config === "object" &&
  config != null &&
  "configurable" in config &&
  typeof config.configurable === "object" &&
  config.configurable != null;

const deleteInternalConfigurableFields = (config: unknown) => {
  if (isConfigurablePresent(config)) {
    const newConfig = {
      ...config,
      configurable: Object.fromEntries(
        Object.entries(config.configurable).filter(
          ([key]) => !key.startsWith("__")
        )
      ),
    };

    delete newConfig.callbacks;
    return newConfig;
  }

  return config;
};

function preprocessDebugCheckpoint(payload: DebugCheckpoint): StreamCheckpoint {
  const result: Record<string, unknown> = {
    ...payload,
    checkpoint: runnableConfigToCheckpoint(payload["config"]),
    parent_checkpoint: runnableConfigToCheckpoint(payload["parentConfig"]),
    tasks: payload["tasks"].map(preprocessDebugCheckpointTask),
  };

  // Handle LangGraph JS pascalCase vs snake_case
  // TODO: use stream to LangGraph.JS
  result.parent_config = payload["parentConfig"];
  delete result.parentConfig;

  result.config = deleteInternalConfigurableFields(result.config);
  result.parent_config = deleteInternalConfigurableFields(result.parent_config);

  return result as StreamCheckpoint;
}

let LANGGRAPH_VERSION: { name: string; version: string } | undefined;

export async function* streamState(
  run: Run,
  options: {
    attempt: number;
    getGraph: (
      graphId: string,
      config: LangGraphRunnableConfig | undefined,
      options?: { checkpointer?: BaseCheckpointSaver | null }
    ) => Promise<Pregel<any, any, any, any, any>>;
    onCheckpoint?: (checkpoint: StreamCheckpoint) => void;
    onTaskResult?: (taskResult: StreamTaskResult) => void;
    signal?: AbortSignal;
  }
): AsyncGenerator<SourceStreamEvent> {
  const kwargs = run.kwargs;
  const graphId = kwargs.config?.configurable?.graph_id;

  if (!graphId || typeof graphId !== "string") {
    throw new Error("Invalid or missing graph_id");
  }

  const graph = await options.getGraph(graphId, kwargs.config, {
    checkpointer: kwargs.temporary ? null : undefined,
  });

  // Only v2 protocol entrypoints opt into `streamStateV2`.
  // Legacy run/stream endpoints stay on the existing `streamEvents`
  // path even if a graph defines stream transformers, so they do not
  // emit protocol-framed events on non-protocol transports.
  const isProtocolV2Run = kwargs[PROTOCOL_STREAM_RUN_KEY] === true;
  if (isProtocolV2Run) {
    yield* streamStateV2(run, { ...options, graph });
    return;
  }

  const userStreamMode = kwargs.stream_mode ?? [];

  const libStreamMode: Set<LangGraphStreamMode> = new Set(
    userStreamMode.filter(
      (mode) => mode !== "events" && mode !== "messages-tuple"
    ) ?? []
  );

  if (userStreamMode.includes("messages-tuple")) {
    libStreamMode.add("messages");
  }

  if (userStreamMode.includes("messages")) {
    libStreamMode.add("values");
  }

  if (!libStreamMode.has("debug")) libStreamMode.add("debug");

  yield {
    event: "metadata",
    data: { run_id: run.run_id, attempt: options.attempt },
  };

  if (!LANGGRAPH_VERSION) {
    const version = await checkLangGraphSemver();
    LANGGRAPH_VERSION = version.find((v) => v.name === "@langchain/langgraph");
  }

  const metadata = {
    ...kwargs.config?.metadata,
    run_attempt: options.attempt,
    langgraph_version: LANGGRAPH_VERSION?.version ?? "0.0.0",
    langgraph_plan: "developer",
    langgraph_host: "self-hosted",
    langgraph_api_url: process.env.LANGGRAPH_API_URL ?? undefined,
  };

  const tracer = run.kwargs?.config?.configurable?.langsmith_project
    ? new LangChainTracer({
        replicas: [
          [
            run.kwargs?.config?.configurable?.langsmith_project as string,
            {
              reference_example_id:
                run.kwargs?.config?.configurable?.langsmith_example_id,
            },
          ],
          [getDefaultProjectName(), undefined],
        ],
      })
    : undefined;

  const events = graph.streamEvents(
    kwargs.command != null
      ? getLangGraphCommand(kwargs.command)
      : (kwargs.input ?? null),
    {
      version: "v2" as const,

      interruptAfter: kwargs.interrupt_after,
      interruptBefore: kwargs.interrupt_before,

      tags: kwargs.config?.tags,
      context: kwargs.context,
      configurable: kwargs.config?.configurable,
      recursionLimit: kwargs.config?.recursion_limit,
      subgraphs: kwargs.subgraphs,
      metadata,

      runId: run.run_id,
      streamMode: [...libStreamMode],
      signal: options?.signal,
      ...(tracer && { callbacks: [tracer] }),
    }
  );

  const messages: Record<string, BaseMessageChunk> = {};
  const completedIds = new Set<string>();

  for await (const event of events) {
    if (event.tags?.includes("langsmith:hidden")) continue;

    if (
      event.event === "on_chain_stream" &&
      (kwargs.subgraphs || event.run_id === run.run_id)
    ) {
      // Pregel's stream tuple is `[ns, mode, payload, meta?]` (4th element
      // is the optional `StreamChunkMeta`, preserved when streaming with
      // `subgraphs: true`). The meta carries the lightweight checkpoint
      // envelope attached by `_emitValuesWithCheckpointMeta`, which we
      // forward as a companion `checkpoints` source event below.
      const rawTuple = (
        kwargs.subgraphs ? event.data.chunk : [null, ...event.data.chunk]
      ) as [string[] | null, LangGraphStreamMode, unknown, unknown?];
      const [ns, mode, chunk] = rawTuple;
      const chunkMeta = rawTuple[3] as
        | { checkpoint?: ProtocolCheckpoint }
        | undefined;

      let data: unknown = chunk;
      if (mode === "debug") {
        const debugChunk = chunk as LangGraphDebugChunk;

        if (debugChunk.type === "checkpoint") {
          const debugCheckpoint = preprocessDebugCheckpoint(debugChunk.payload);
          options?.onCheckpoint?.(debugCheckpoint);
          data = { ...debugChunk, payload: debugCheckpoint };
        } else if (debugChunk.type === "task_result") {
          const debugResult = preprocessDebugCheckpointTask(debugChunk.payload);
          options?.onTaskResult?.(debugResult);
          data = { ...debugChunk, payload: debugResult };
        }
      } else if (mode === "checkpoints") {
        const debugCheckpoint = preprocessDebugCheckpoint(
          chunk as DebugCheckpoint
        );
        options?.onCheckpoint?.(debugCheckpoint);
        data = debugCheckpoint;
      } else if (mode === "tasks") {
        const debugTask = preprocessDebugCheckpointTask(chunk as DebugTask);
        if ("result" in debugTask || "error" in debugTask) {
          options?.onTaskResult?.(debugTask);
        }
        data = debugTask;
      }

      // Emit the lightweight checkpoint envelope as a dedicated
      // `checkpoints` source event immediately BEFORE the companion
      // `values` event so clients subscribed to both channels have the
      // envelope buffered by the time the values payload arrives
      // (`useMessageMetadata(msg.id).parentCheckpointId` for fork /
      // edit flows). Clients that only want fork / time-travel metadata
      // subscribe to `checkpoints` alone and avoid the full-state
      // payload.
      if (mode === "values" && chunkMeta?.checkpoint != null) {
        const sseEvent =
          kwargs.subgraphs && ns?.length
            ? `checkpoints|${ns.join("|")}`
            : "checkpoints";
        yield { event: sseEvent, data: chunkMeta.checkpoint };
      }

      if (mode === "messages") {
        if (userStreamMode.includes("messages-tuple")) {
          if (kwargs.subgraphs && ns?.length) {
            yield { event: `messages|${ns.join("|")}`, data };
          } else {
            yield { event: "messages", data };
          }
        }
      } else if (userStreamMode.includes(mode)) {
        const sseEvent =
          kwargs.subgraphs && ns?.length ? `${mode}|${ns.join("|")}` : mode;
        yield { event: sseEvent, data };
      }
    } else if (userStreamMode.includes("events")) {
      yield { event: "events", data: event };
    }

    // TODO: we still rely on old messages mode based of streamMode=values
    // In order to fully switch to library messages mode, we need to do ensure that
    // `StreamMessagesHandler` sends the final message, which requires the following:
    // - handleLLMEnd does not send the final message b/c handleLLMNewToken sets the this.emittedChatModelRunIds[runId] flag. Python does not do that
    // - handleLLMEnd receives the final message as BaseMessageChunk rather than BaseMessage, which from the outside will become indistinguishable.
    // - handleLLMEnd should not dedupe the message
    // - Don't think there's an utility that would convert a BaseMessageChunk to a BaseMessage?
    if (userStreamMode.includes("messages")) {
      if (
        event.event === "on_chain_stream" &&
        (kwargs.subgraphs || event.run_id === run.run_id)
      ) {
        const newMessages: Array<BaseMessageChunk> = [];
        const [_, chunk]: [string, any] = event.data.chunk;

        let chunkMessages: Array<BaseMessageChunk> = [];
        if (
          typeof chunk === "object" &&
          chunk != null &&
          "messages" in chunk &&
          !isBaseMessage(chunk)
        ) {
          chunkMessages = chunk?.messages;
        }

        if (!Array.isArray(chunkMessages)) {
          chunkMessages = [chunkMessages];
        }

        for (const message of chunkMessages) {
          if (!message.id || completedIds.has(message.id)) continue;
          completedIds.add(message.id);
          newMessages.push(message);
        }

        if (newMessages.length > 0) {
          yield { event: "messages/complete", data: newMessages };
        }
      } else if (
        event.event === "on_chat_model_stream" &&
        !event.tags?.includes("nostream")
      ) {
        const message: BaseMessageChunk = event.data.chunk;

        if (!message.id) continue;

        if (messages[message.id] == null) {
          messages[message.id] = message;
          yield {
            event: "messages/metadata",
            data: { [message.id]: { metadata: event.metadata } },
          };
        } else {
          messages[message.id] = messages[message.id].concat(message);
        }

        yield { event: "messages/partial", data: [messages[message.id]] };
      }
    }
  }

  if (kwargs.feedback_keys) {
    const client = new LangSmithClient();
    const data = Object.fromEntries(
      await Promise.all(
        kwargs.feedback_keys.map(async (feedback) => {
          const { url } = await client.createPresignedFeedbackToken(
            run.run_id,
            feedback
          );
          return [feedback, url];
        })
      )
    );

    yield { event: "feedback", data };
  }
}

function isUnsupportedStreamEventsV3Error(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      'Only versions "v1" and "v2" of the schema are currently supported'
    )
  );
}

async function* fallbackProtocolStreamFromGraphStream(
  graph: Pregel<any, any, any, any, any>,
  input: unknown,
  options: Parameters<Pregel<any, any, any, any, any>["stream"]>[1]
): AsyncGenerator<{
  method: string;
  params: { namespace: string[]; data: unknown };
}> {
  let seq = 0;
  const stream = await graph.stream(input, options);
  for await (const tuple of stream as AsyncIterable<
    [string[] | [], LangGraphStreamMode, unknown, unknown?]
  >) {
    const [namespace, mode, payload, meta] = tuple;
    const events = convertToProtocolEvent({
      namespace: namespace ?? [],
      mode,
      payload,
      seq,
      meta: meta as never,
    });
    seq += events.length;
    for (const event of events) {
      yield event;
    }
  }
}

/**
 * Executes a graph run using `graph.streamEvents(..., { version: "v3" })`
 * and maps the resulting `ProtocolEvent` objects into the `{ event, data }`
 * shape consumed by both the legacy SSE path and the protocol v2 session.
 *
 * This path activates graph-level `streamTransformers` (registered via
 * `.compile({ transformers })`) so that custom transformer output flows to
 * clients automatically.
 *
 * @param run - The queued run to execute.
 * @param options - Callbacks and graph-loading infrastructure.
 * @returns Async generator of `{ event, data }` pairs.
 */
export async function* streamStateV2(
  run: Run,
  options: {
    attempt: number;
    graph: Pregel<any, any, any, any, any>;
    getGraph: (
      graphId: string,
      config: LangGraphRunnableConfig | undefined,
      options?: { checkpointer?: BaseCheckpointSaver | null }
    ) => Promise<Pregel<any, any, any, any, any>>;
    onCheckpoint?: (checkpoint: StreamCheckpoint) => void;
    onTaskResult?: (taskResult: StreamTaskResult) => void;
    signal?: AbortSignal;
  }
): AsyncGenerator<SourceStreamEvent> {
  const kwargs = run.kwargs;
  const graph = options.graph;

  yield {
    event: "metadata",
    data: { run_id: run.run_id, attempt: options.attempt },
  };

  if (!LANGGRAPH_VERSION) {
    const version = await checkLangGraphSemver();
    LANGGRAPH_VERSION = version.find((v) => v.name === "@langchain/langgraph");
  }

  const metadata = {
    ...kwargs.config?.metadata,
    run_attempt: options.attempt,
    langgraph_version: LANGGRAPH_VERSION?.version ?? "0.0.0",
    langgraph_plan: "developer",
    langgraph_host: "self-hosted",
    langgraph_api_url: process.env.LANGGRAPH_API_URL ?? undefined,
  };

  const tracer = run.kwargs?.config?.configurable?.langsmith_project
    ? new LangChainTracer({
        replicas: [
          [
            run.kwargs?.config?.configurable?.langsmith_project as string,
            {
              reference_example_id:
                run.kwargs?.config?.configurable?.langsmith_example_id,
            },
          ],
          [getDefaultProjectName(), undefined],
        ],
      })
    : undefined;

  const graphInput =
    kwargs.command != null
      ? getLangGraphCommand(kwargs.command)
      : (kwargs.input ?? null);
  const graphOptions = {
    version: "v3",
    interruptAfter: kwargs.interrupt_after,
    interruptBefore: kwargs.interrupt_before,

    tags: kwargs.config?.tags,
    context: kwargs.context,
    configurable: kwargs.config?.configurable,
    recursionLimit: kwargs.config?.recursion_limit,
    metadata: { ls_integration: "langgraph", ...metadata },

    runId: run.run_id,
    signal: options?.signal,
    ...(tracer && { callbacks: [tracer] }),
  } as const;

  let graphRun: AsyncIterable<{
    method: string;
    params: { namespace: string[]; data: unknown };
  }>;
  try {
    graphRun = await graph.streamEvents(graphInput, graphOptions);
  } catch (error) {
    if (!isUnsupportedStreamEventsV3Error(error)) {
      throw error;
    }
    graphRun = fallbackProtocolStreamFromGraphStream(graph, graphInput, {
      ...graphOptions,
      streamMode: STREAM_EVENTS_V3_MODES,
      subgraphs: true as const,
    });
  }

  for await (const event of graphRun) {
    const ns = event.params.namespace;
    const mode = event.method;
    const data = event.params.data;

    if (mode === "debug") {
      const debugChunk = data as LangGraphDebugChunk;
      if (debugChunk.type === "checkpoint") {
        const debugCheckpoint = preprocessDebugCheckpoint(debugChunk.payload);
        options?.onCheckpoint?.(debugCheckpoint);
        const sseEvent = ns.length > 0 ? `${mode}|${ns.join("|")}` : mode;
        yield {
          event: sseEvent,
          data: { ...debugChunk, payload: debugCheckpoint },
        };
        continue;
      } else if (debugChunk.type === "task_result") {
        const debugResult = preprocessDebugCheckpointTask(debugChunk.payload);
        options?.onTaskResult?.(debugResult);
        const sseEvent = ns.length > 0 ? `${mode}|${ns.join("|")}` : mode;
        yield {
          event: sseEvent,
          data: { ...debugChunk, payload: debugResult },
        };
        continue;
      }
    } else if (mode === "tasks") {
      const debugTask = preprocessDebugCheckpointTask(data as DebugTask);
      if ("result" in debugTask || "error" in debugTask) {
        options?.onTaskResult?.(debugTask);
      }
      const sseEvent = ns.length > 0 ? `${mode}|${ns.join("|")}` : mode;
      yield { event: sseEvent, data: debugTask };
      continue;
    }

    const sseEvent = ns.length > 0 ? `${mode}|${ns.join("|")}` : mode;

    /**
     * These modes have already been converted to their protocol shape by
     * core's `convertToProtocolEvent`, so the session can skip
     * re-normalization.  Other modes (values, debug, tasks) still
     * require API-specific processing (interrupt stripping, state
     * message normalization, checkpoint preprocessing). `checkpoints`
     * is emitted by core as a standalone protocol event whose `data` is
     * already the lightweight envelope; the session frames it on the
     * dedicated `checkpoints` channel.  `lifecycle` events are
     * synthesized by core's `LifecycleTransformer` and forwarded
     * verbatim by the session.
     */
    const normalized =
      mode === "tools" ||
      mode === "updates" ||
      mode === "custom" ||
      mode === "messages" ||
      mode === "checkpoints" ||
      mode === "lifecycle";

    yield { event: sseEvent, data, normalized };
  }

  if (kwargs.feedback_keys) {
    const client = new LangSmithClient();
    const feedbackData = Object.fromEntries(
      await Promise.all(
        kwargs.feedback_keys.map(async (feedback) => {
          const { url } = await client.createPresignedFeedbackToken(
            run.run_id,
            feedback
          );
          return [feedback, url];
        })
      )
    );

    yield { event: "feedback", data: feedbackData };
  }
}
