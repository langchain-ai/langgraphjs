import { Run, RunCommand, RunnableConfig, RunSend } from "./storage/ops.mjs";
import { getGraph } from "./graph/load.mjs";

import {
  CheckpointMetadata,
  Command,
  Interrupt,
  Send,
  StateSnapshot,
} from "@langchain/langgraph";
import { runnableConfigToCheckpoint } from "./utils/config.mjs";

// TODO: these types are not exported from @langchain/langgraph/pregel
type LangGraphStreamMode =
  | "values"
  | "messages"
  | "updates"
  | "debug"
  | "custom";

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
  parent_config: RunnableConfig | undefined;
  values: unknown;
  metadata: CheckpointMetadata;
  next: string[];
  tasks: DebugTask[];
}

type LangGraphDebugChunk =
  | DebugChunk<"checkpoint", DebugCheckpoint>
  | DebugChunk<"task_result", DebugTask>;

const getLangGraphCommand = (command: RunCommand) => {
  let goto =
    command.goto != null && !Array.isArray(command.goto)
      ? [command.goto]
      : command.goto;

  return new Command({
    goto: goto?.map((item: string | RunSend) => {
      if (typeof item !== "string") return new Send(item.node, item.input);
      return item;
    }),
    update: command.update,
    resume: command.resume,
  });
};

const isRunnableConfig = (config: unknown): config is RunnableConfig => {
  if (typeof config !== "object" || config == null) return false;
  return (
    "configurable" in config &&
    typeof config.configurable === "object" &&
    config.configurable != null
  );
};

function preprocessDebugCheckpointTask(
  task: DebugTask
): Record<string, unknown> {
  if (
    !isRunnableConfig(task.state) ||
    !runnableConfigToCheckpoint(task.state)
  ) {
    return task as unknown as Record<string, unknown>;
  }

  const cloneTask: Record<string, unknown> = { ...task };
  cloneTask.checkpoint = runnableConfigToCheckpoint(task.state);
  delete cloneTask.state;

  return cloneTask;
}

type StreamCheckpoint = ReturnType<typeof preprocessDebugCheckpoint>;
type StreamTaskResult = ReturnType<typeof preprocessDebugCheckpointTask>;

function preprocessDebugCheckpoint(payload: DebugCheckpoint) {
  return {
    ...payload,
    checkpoint: runnableConfigToCheckpoint(payload["config"]),
    parent_checkpoint: runnableConfigToCheckpoint(payload["parent_config"]),
    tasks: payload["tasks"].map(preprocessDebugCheckpointTask),
  };
}

export async function* streamState(
  run: Run,
  attempt: number = 1,
  options?: {
    onCheckpoint?: (checkpoint: StreamCheckpoint) => void;
    onTaskResult?: (taskResult: StreamTaskResult) => void;
  }
): AsyncGenerator<{ event: string; data: unknown }> {
  const kwargs = run.kwargs;
  const graphId = kwargs.config?.configurable?.graph_id;

  if (!graphId || typeof graphId !== "string") {
    throw new Error("Invalid or missing graph_id");
  }

  const graph = getGraph(graphId, {
    checkpointer: kwargs.temporary ? null : undefined,
  });

  const libStreamMode: Set<LangGraphStreamMode> = new Set(
    kwargs.stream_mode?.filter((mode) => mode !== "events") ?? []
  );

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
  };

  const params = {
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
  };

  const events = graph.streamEvents(
    kwargs.command != null ? getLangGraphCommand(kwargs.command) : kwargs.input,
    params
  );

  for await (const event of events) {
    if (event.tags?.includes("langsmith:hidden")) continue;

    if (event.event === "on_chain_stream" && event.run_id === run.run_id) {
      const [ns, mode, chunk] = (
        kwargs.subgraphs ? event.data.chunk : [null, ...event.data.chunk]
      ) as [string[] | null, LangGraphStreamMode, unknown];

      // Listen for debug events and capture checkpoint
      if (mode === "debug") {
        const debugChunk = chunk as LangGraphDebugChunk;
        if (debugChunk.type === "checkpoint") {
          options?.onCheckpoint?.(
            preprocessDebugCheckpoint(debugChunk.payload)
          );
        } else if (debugChunk.type === "task_result") {
          options?.onTaskResult?.(
            preprocessDebugCheckpointTask(debugChunk.payload)
          );
        }
      }

      // TODO: implement messages-tuple

      if (mode !== "custom" && kwargs.stream_mode?.includes(mode)) {
        if (kwargs.subgraphs && ns?.length) {
          yield { event: `${mode}|${ns.join("|")}`, data: chunk };
        } else {
          yield { event: mode, data: chunk };
        }
      }
    } else if (kwargs.stream_mode?.includes("events")) {
      yield { event: "events", data: event };
    }
  }
}
