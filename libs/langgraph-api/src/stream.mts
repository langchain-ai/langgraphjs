import type { Run, RunnableConfig, Checkpoint } from "./storage/ops.mjs";
import { getGraph } from "./graph/load.mjs";
import { Client as LangSmithClient } from "langsmith";
import {
  type CheckpointMetadata,
  type Interrupt,
  type StateSnapshot,
} from "@langchain/langgraph";
import type { Pregel } from "@langchain/langgraph/pregel";
import {
  runnableConfigToCheckpoint,
  taskRunnableConfigToCheckpoint,
} from "./utils/runnableConfig.mjs";
import { BaseMessageChunk, isBaseMessage } from "@langchain/core/messages";
import { getLangGraphCommand } from "./command.mjs";

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
  config: unknown,
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
          ([key]) => !key.startsWith("__"),
        ),
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

export async function* streamState(
  run: Run,
  attempt: number = 1,
  options?: {
    onCheckpoint?: (checkpoint: StreamCheckpoint) => void;
    onTaskResult?: (taskResult: StreamTaskResult) => void;
    signal?: AbortSignal;
  },
): AsyncGenerator<{ event: string; data: unknown }> {
  const kwargs = run.kwargs;
  const graphId = kwargs.config?.configurable?.graph_id;

  if (!graphId || typeof graphId !== "string") {
    throw new Error("Invalid or missing graph_id");
  }

  const graph = await getGraph(graphId, kwargs.config, {
    checkpointer: kwargs.temporary ? null : undefined,
  });

  const userStreamMode = kwargs.stream_mode ?? [];

  const libStreamMode: Set<LangGraphStreamMode> = new Set(
    userStreamMode.filter(
      (mode) => mode !== "events" && mode !== "messages-tuple",
    ) ?? [],
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
    data: { run_id: run.run_id, attempt },
  };

  const metadata = {
    ...kwargs.config?.metadata,
    run_attempt: attempt,
    // TODO: get langgraph version from NPM / load.hooks.mjs
    langgraph_version: "0.2.35",
    langgraph_plan: "developer",
    langgraph_host: "self-hosted",
    langgraph_api_url: process.env.LANGGRAPH_API_URL ?? undefined,
  };

  const events = graph.streamEvents(
    kwargs.command != null
      ? getLangGraphCommand(kwargs.command)
      : (kwargs.input ?? null),
    {
      version: "v2" as const,

      interruptAfter: kwargs.interrupt_after,
      interruptBefore: kwargs.interrupt_before,

      tags: kwargs.config?.tags,
      configurable: kwargs.config?.configurable,
      recursionLimit: kwargs.config?.recursion_limit,
      subgraphs: kwargs.subgraphs,
      metadata,

      runId: run.run_id,
      streamMode: [...libStreamMode],
      signal: options?.signal,
    },
  );

  const messages: Record<string, BaseMessageChunk> = {};
  const completedIds = new Set<string>();

  for await (const event of events) {
    if (event.tags?.includes("langsmith:hidden")) continue;

    if (event.event === "on_chain_stream" && event.run_id === run.run_id) {
      const [ns, mode, chunk] = (
        kwargs.subgraphs ? event.data.chunk : [null, ...event.data.chunk]
      ) as [string[] | null, LangGraphStreamMode, unknown];

      // Listen for debug events and capture checkpoint
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
      }

      if (mode === "messages") {
        if (userStreamMode.includes("messages-tuple")) {
          yield { event: "messages", data };
        }
      } else if (userStreamMode.includes(mode)) {
        if (kwargs.subgraphs && ns?.length) {
          yield { event: `${mode}|${ns.join("|")}`, data };
        } else {
          yield { event: mode, data };
        }
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
      if (event.event === "on_chain_stream" && event.run_id === run.run_id) {
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
            feedback,
          );
          return [feedback, url];
        }),
      ),
    );

    yield { event: "feedback", data };
  }
}
