import type {
  StateSnapshot as LangGraphStateSnapshot,
  CheckpointMetadata as LangGraphCheckpointMetadata,
  LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { HTTPException } from "hono/http-exception";
import { v4 as uuid } from "uuid";
import { getGraph } from "../graph/load.mjs";
import { checkpointer } from "./checkpoint.mjs";
import { store } from "./store.mjs";

export type Metadata = Record<string, unknown>;

export type ThreadStatus = "idle" | "busy" | "interrupted" | "error";

export type RunStatus =
  | "pending"
  | "running"
  | "error"
  | "success"
  | "timeout"
  | "interrupted";

export type StreamMode = "values" | "messages" | "updates" | "events" | "debug";

export type MultitaskStrategy = "reject" | "rollback" | "interrupt" | "enqueue";

export type OnConflictBehavior = "raise" | "do_nothing";

export type IfNotExists = "create" | "reject";

export interface RunnableConfig {
  tags?: string[];

  recursion_limit?: number;

  configurable?: {
    thread_id?: string;
    thread_ts?: string;
    [key: string]: unknown;
  };

  metadata?: LangGraphRunnableConfig["metadata"];
}

interface Assistant {
  name: string | undefined;
  assistant_id: string;
  graph_id: string;
  created_at: Date;
  updated_at: Date;
  version: number;
  config: RunnableConfig;
  metadata: Metadata;
}

interface AssistantVersion {
  assistant_id: string;
  version: number;
  graph_id: string;
  config: RunnableConfig;
  metadata: Metadata;
  created_at: Date;
}

export interface RunSend {
  node: string;
  input?: Record<string, any>;
}

export interface RunCommand {
  goto?: string | RunSend | Array<RunSend | string>;
  update?: Record<string, unknown> | [string, unknown][];
  resume?: unknown;
}

export interface RunKwargs {
  input?: unknown;
  command?: RunCommand;

  stream_mode?: Array<StreamMode>;

  interrupt_before?: "*" | string[] | undefined;
  interrupt_after?: "*" | string[] | undefined;

  config: RunnableConfig;

  subgraphs?: boolean;
  temporary?: boolean;

  // TODO: implement webhook
  webhook?: unknown;

  // TODO: implement feedback_keys
  feedback_keys?: string | string[] | undefined;

  [key: string]: unknown;
}

export interface Run {
  run_id: string;
  thread_id: string;
  assistant_id: string;
  created_at: Date;
  updated_at: Date;
  status: RunStatus;
  metadata: Metadata;
  kwargs: RunKwargs;
  multitask_strategy: MultitaskStrategy;
}

const STORE: {
  runs: Record<string, Run>;
  threads: Record<string, Thread>;
  assistants: Record<string, Assistant>;
  assistant_versions: AssistantVersion[];
} = {
  runs: {},
  threads: {},
  assistants: {},
  assistant_versions: [],
};

export const truncate = (flags: {
  runs?: boolean;
  threads?: boolean;
  assistants?: boolean;
  checkpointer?: boolean;
  store?: boolean;
}) => {
  if (flags.runs) STORE.runs = {};
  if (flags.threads) STORE.threads = {};
  if (flags.assistants) {
    STORE.assistants = Object.fromEntries(
      Object.entries(STORE.assistants).filter(
        ([_key, assistant]) =>
          !assistant.metadata?.created_by ||
          assistant.metadata?.created_by === "system"
      )
    );
  }

  if (flags.checkpointer) checkpointer.clear();
  if (flags.store) store.clear();
};

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const isJsonbContained = (
  superset: Record<string, unknown> | undefined,
  subset: Record<string, unknown> | undefined
): boolean => {
  if (superset == null || subset == null) return true;
  for (const [key, value] of Object.entries(subset)) {
    if (superset[key] == null) return false;

    if (isObject(value) && isObject(superset[key])) {
      if (!isJsonbContained(superset[key], value)) return false;
    } else if (superset[key] !== value) {
      return false;
    }
  }

  return true;
};

export class Assistants {
  static async *search(options: {
    graph_id?: string;
    metadata?: Metadata;
    limit: number;
    offset: number;
  }) {
    let filtered = Object.values(STORE.assistants)
      .filter((assistant) => {
        if (
          options.graph_id != null &&
          assistant["graph_id"] !== options.graph_id
        ) {
          return false;
        }

        if (
          options.metadata != null &&
          !isJsonbContained(assistant["metadata"], options.metadata)
        ) {
          return false;
        }

        return true;
      })
      .sort((a, b) => {
        const aCreatedAt = a["created_at"]?.getTime() ?? 0;
        const bCreatedAt = b["created_at"]?.getTime() ?? 0;
        return bCreatedAt - aCreatedAt;
      });

    for (const assistant of filtered.slice(
      options.offset,
      options.offset + options.limit
    )) {
      yield assistant;
    }
  }

  static async get(assistantId: string): Promise<Assistant> {
    const result = STORE.assistants[assistantId];
    if (result == null)
      throw new HTTPException(404, { message: "Assistant not found" });
    return result;
  }

  static async put(
    assistantId: string,
    options: {
      config: RunnableConfig;
      graph_id: string;
      metadata?: Metadata;
      if_exists: OnConflictBehavior;
      name?: string;
    }
  ): Promise<Assistant> {
    if (STORE.assistants[assistantId] != null) {
      if (options.if_exists === "raise") {
        throw new HTTPException(409, { message: "Assistant already exists" });
      }
      return STORE.assistants[assistantId];
    }

    const now = new Date();

    STORE.assistants[assistantId] ??= {
      assistant_id: assistantId,
      version: 1,
      config: options.config ?? {},
      created_at: now,
      updated_at: now,
      graph_id: options.graph_id,
      metadata: options.metadata ?? ({} as Metadata),
      name: options.name,
    };

    STORE.assistant_versions.push({
      assistant_id: assistantId,
      version: 1,
      graph_id: options.graph_id,
      config: options.config ?? {},
      metadata: options.metadata ?? ({} as Metadata),
      created_at: now,
    });

    return STORE.assistants[assistantId];
  }

  static async patch(
    assistantId: string,
    options?: {
      config?: RunnableConfig;
      graph_id?: string;
      metadata?: Metadata;
      name?: string;
    }
  ): Promise<Assistant> {
    const assistant = STORE.assistants[assistantId];
    if (!assistant)
      throw new HTTPException(404, { message: "Assistant not found" });

    const now = new Date();

    const metadata =
      options?.metadata != null
        ? {
            ...assistant["metadata"],
            ...options.metadata,
          }
        : null;

    if (options?.graph_id != null) {
      assistant["graph_id"] = options?.graph_id ?? assistant["graph_id"];
    }

    if (options?.config != null) {
      assistant["config"] = options?.config ?? assistant["config"];
    }

    if (options?.name != null) {
      assistant["name"] = options?.name ?? assistant["name"];
    }

    if (metadata != null) {
      assistant["metadata"] = metadata ?? assistant["metadata"];
    }

    assistant["updated_at"] = now;

    const newVersion =
      Math.max(
        ...STORE.assistant_versions
          .filter((v) => v["assistant_id"] === assistantId)
          .map((v) => v["version"])
      ) + 1;

    const newVersionEntry = {
      assistant_id: assistantId,
      version: newVersion,
      graph_id: options?.graph_id ?? assistant["graph_id"],
      config: options?.config ?? assistant["config"],
      metadata: metadata ?? assistant["metadata"],
      created_at: now,
    };

    STORE.assistant_versions.push(newVersionEntry);
    return assistant;
  }

  static async delete(assistantId: string): Promise<string[]> {
    const assistant = STORE.assistants[assistantId];
    if (!assistant)
      throw new HTTPException(404, { message: "Assistant not found" });

    delete STORE.assistants[assistantId];

    // Cascade delete for assistant versions and crons
    STORE.assistant_versions = STORE.assistant_versions.filter(
      (v) => v["assistant_id"] !== assistantId
    );

    for (const run of Object.values(STORE.runs)) {
      if (run["assistant_id"] === assistantId) {
        delete STORE.runs[run["run_id"]];
      }
    }

    return [assistant.assistant_id];
  }

  static async setLatest(
    assistantId: string,
    version: number
  ): Promise<Assistant> {
    const assistant = STORE.assistants[assistantId];
    if (!assistant)
      throw new HTTPException(404, { message: "Assistant not found" });

    const assistantVersion = STORE.assistant_versions.find(
      (v) => v["assistant_id"] === assistantId && v["version"] === version
    );

    if (!assistantVersion)
      throw new HTTPException(404, { message: "Assistant version not found" });

    const now = new Date();
    STORE.assistants[assistantId] = {
      ...assistant,
      config: assistantVersion["config"],
      metadata: assistantVersion["metadata"],
      version: assistantVersion["version"],
      updated_at: now,
    };

    return STORE.assistants[assistantId];
  }

  static async *getVersions(
    assistantId: string,
    options: {
      limit: number;
      offset: number;
      metadata?: Metadata;
    }
  ) {
    const versions = STORE.assistant_versions
      .filter((version) => {
        if (version["assistant_id"] !== assistantId) return false;

        if (
          options.metadata != null &&
          !isJsonbContained(version["metadata"], options.metadata)
        ) {
          return false;
        }

        return true;
      })
      .sort((a, b) => b["version"] - a["version"]);

    for (const version of versions.slice(
      options.offset,
      options.offset + options.limit
    )) {
      yield version;
    }
  }
}

interface Thread {
  thread_id: string;
  created_at: Date;
  updated_at: Date;
  metadata?: Metadata;
  config?: RunnableConfig;
  status: ThreadStatus;
  values?: Record<string, unknown>;
  interrupts?: Record<string, unknown>;
}

interface CheckpointTask {
  id: string;
  name: string;
  error?: string;
  interrupts: Record<string, unknown>;
  state?: RunnableConfig;
}

interface CheckpointPayload {
  config?: RunnableConfig;
  metadata: LangGraphCheckpointMetadata;
  values: Record<string, unknown>;
  next: string[];
  parent_config?: RunnableConfig;
  tasks: CheckpointTask[];
}

export interface Checkpoint {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string | null;
  checkpoint_map: Record<string, unknown> | null;
}

interface ThreadTask {
  id: string;
  name: string;
  error?: string;
  interrupts: Record<string, unknown>[];
  checkpoint: Checkpoint | null;
  state?: ThreadState;
  result?: Record<string, unknown>;
}

export interface ThreadState {
  values: Record<string, unknown>;
  next: string[];
  checkpoint: Checkpoint | null;
  metadata: Record<string, unknown> | undefined;
  created_at: Date | null;
  parent_checkpoint: Checkpoint | null;
  tasks: ThreadTask[];
}

export class Threads {
  static async *search(options: {
    metadata?: Metadata;
    status?: ThreadStatus;
    values?: Record<string, unknown>;
    limit: number;
    offset: number;
  }): AsyncGenerator<Thread> {
    const filtered = Object.values(STORE.threads)
      .filter((thread) => {
        if (
          options.metadata != null &&
          !isJsonbContained(thread["metadata"], options.metadata)
        )
          return false;

        if (
          options.values != null &&
          typeof thread["values"] !== "undefined" &&
          !isJsonbContained(thread["values"], options.values)
        )
          return false;

        if (options.status != null && thread["status"] !== options.status)
          return false;

        return true;
      })
      .sort((a, b) => b["created_at"].getTime() - a["created_at"].getTime());

    for (const thread of filtered.slice(
      options.offset,
      options.offset + options.limit
    )) {
      yield thread;
    }
  }

  static async get(threadId: string): Promise<Thread> {
    const result = STORE.threads[threadId];
    if (result == null)
      throw new HTTPException(404, {
        message: `Thread with ID ${threadId} not found`,
      });

    return result;
  }

  static async put(
    threadId: string,
    options?: {
      metadata?: Metadata;
      if_exists: OnConflictBehavior;
    }
  ): Promise<Thread> {
    const now = new Date();

    if (STORE.threads[threadId] != null) {
      if (options?.if_exists === "raise") {
        throw new HTTPException(409, { message: "Thread already exists" });
      }
      return STORE.threads[threadId];
    }

    STORE.threads[threadId] ??= {
      thread_id: threadId,
      created_at: now,
      updated_at: now,
      metadata: options?.metadata ?? {},
      status: "idle",
      config: {},
      values: undefined,
    };

    return STORE.threads[threadId];
  }

  static async patch(
    threadId: string,
    options?: {
      metadata?: Metadata;
    }
  ): Promise<Thread> {
    const thread = STORE.threads[threadId];
    if (!thread) throw new HTTPException(404, { message: "Thread not found" });

    const now = new Date();
    if (options?.metadata != null) {
      thread["metadata"] = {
        ...thread["metadata"],
        ...options.metadata,
      };
    }

    thread["updated_at"] = now;
    return thread;
  }

  static async setStatus(
    threadId: string,
    options: {
      checkpoint?: CheckpointPayload;
      exception?: Error;
    }
  ) {
    const thread = STORE.threads[threadId];
    if (!thread) throw new HTTPException(404, { message: "Thread not found" });

    let hasNext = false;
    if (options.checkpoint != null) {
      hasNext = options.checkpoint.next.length > 0;
    }

    const hasPendingRuns = Object.values(STORE.runs).some(
      (run) => run["thread_id"] === threadId && run["status"] === "pending"
    );

    let status: ThreadStatus = "idle";

    if (options.exception != null) {
      status = "error";
    } else if (hasNext) {
      status = "interrupted";
    } else if (hasPendingRuns) {
      status = "busy";
    }

    const now = new Date();
    thread.updated_at = now;
    thread.status = status;
    thread.values =
      options.checkpoint != null ? options.checkpoint.values : undefined;
    thread.interrupts =
      options.checkpoint != null
        ? options.checkpoint.tasks.reduce<Record<string, unknown>>(
            (acc, task) => {
              if (task.interrupts) acc[task.id] = task.interrupts;
              return acc;
            },
            {}
          )
        : undefined;
  }

  static async delete(threadId: string): Promise<string[]> {
    const thread = STORE.threads[threadId];
    if (!thread)
      throw new HTTPException(404, {
        message: `Thread with ID ${threadId} not found`,
      });

    delete STORE.threads[threadId];
    for (const run of Object.values(STORE.runs)) {
      if (run["thread_id"] === threadId) {
        delete STORE.runs[run["run_id"]];
      }
    }

    return [thread.thread_id];
  }

  static async copy(threadId: string): Promise<Thread> {
    const thread = STORE.threads[threadId];
    if (!thread) throw new HTTPException(409, { message: "Thread not found" });

    const newThreadId = uuid();

    const now = new Date();
    STORE.threads[newThreadId] = {
      thread_id: newThreadId,
      created_at: now,
      updated_at: now,
      metadata: { ...thread.metadata },
      config: {},
      status: "idle",
    };

    // copy stroage over
    const newThreadCheckpoints: (typeof checkpointer.storage)[string] = {};
    for (const oldNs of Object.keys(checkpointer.storage[threadId])) {
      const newNs = oldNs.replace(threadId, newThreadId);

      for (const oldId of Object.keys(checkpointer.storage[threadId][oldNs])) {
        const newId = oldId.replace(threadId, newThreadId);

        const [checkpoint, metadata, oldParentId] =
          checkpointer.storage[threadId][oldNs][oldId];

        const newParentId = oldParentId?.replace(threadId, newThreadId);

        newThreadCheckpoints[newNs] ??= {};
        newThreadCheckpoints[newNs][newId] = [
          checkpoint,
          metadata,
          newParentId,
        ];
      }
    }
    checkpointer.storage[newThreadId] = newThreadCheckpoints;

    // copy writes over (if any)
    type WriteKey = [
      threadId: string,
      checkpointNamespace: string,
      checkpointId: string,
    ];

    const deserializeKey = (key: string): WriteKey => {
      const [threadId, checkpointNamespace, checkpointId] = JSON.parse(key);
      return [threadId, checkpointNamespace, checkpointId];
    };

    const serializeKey = (key: WriteKey): string => {
      return JSON.stringify(key);
    };

    const outerKeys: string[] = [];
    for (const keyJson of Object.keys(checkpointer.writes)) {
      const key = deserializeKey(keyJson);
      if (key[0] === threadId) outerKeys.push(keyJson);
    }

    for (const keyJson of outerKeys) {
      const [_threadId, checkpointNamespace, checkpointId] =
        deserializeKey(keyJson);

      checkpointer.writes[
        serializeKey([newThreadId, checkpointNamespace, checkpointId])
      ] = structuredClone(checkpointer.writes[keyJson]);
    }

    return STORE.threads[newThreadId];
  }

  static State = class {
    static async get(
      config: RunnableConfig,
      options: {
        subgraphs?: boolean;
      }
    ): Promise<LangGraphStateSnapshot> {
      const subgraphs = options.subgraphs ?? false;
      const threadId = config.configurable?.thread_id;
      const thread = threadId ? await Threads.get(threadId) : undefined;

      if (!thread) {
        return {
          values: {},
          next: [],
          config: {},
          metadata: undefined,
          createdAt: undefined,
          parentConfig: undefined,
          tasks: [],
        };
      }

      const metadata = thread.metadata ?? {};
      // TODO: use the copied thread loader

      const graphId = metadata.graph_id as string | undefined | null;

      if (graphId != null) {
        const graph = await getGraph(graphId, { checkpointer, store });
        const result = await graph.getState(config, { subgraphs });

        if (
          result.metadata != null &&
          "checkpoint_ns" in result.metadata &&
          result.metadata["checkpoint_ns"] === ""
        ) {
          delete result.metadata["checkpoint_ns"];
        }

        return result;
      } else {
        return {
          values: {},
          next: [],
          config: {},
          metadata: undefined,
          createdAt: undefined,
          parentConfig: undefined,
          tasks: [],
        };
      }
    }

    static async post(
      config: RunnableConfig,
      values?: Record<string, unknown>[] | Record<string, unknown> | undefined,
      asNode?: string | undefined
    ) {
      const threadId = config.configurable?.thread_id;
      const thread = threadId ? await Threads.get(threadId) : undefined;
      if (!thread)
        throw new HTTPException(404, {
          message: `Thread ${threadId} not found`,
        });

      const graphId = thread.metadata?.graph_id as string | undefined | null;

      if (graphId == null) {
        throw new HTTPException(400, {
          message: `Thread ${threadId} has no graph ID`,
        });
      }

      config.configurable ??= {};
      config.configurable.graph_id ??= graphId;

      const graph = await getGraph(graphId, { checkpointer, store });

      const updateConfig = structuredClone(config);
      updateConfig.configurable ??= {};
      updateConfig.configurable.checkpoint_ns ??= "";

      const nextConfig = await graph.updateState(updateConfig, values, asNode);

      const state = await Threads.State.get(config, { subgraphs: false });

      // update thread values
      for (const thread of Object.values(STORE.threads)) {
        if (thread.thread_id === threadId) {
          thread.values = state.values;
          break;
        }
      }

      return { checkpoint: nextConfig.configurable };
    }

    static async list(
      config: RunnableConfig,
      options?: {
        limit?: number;
        before?: string | RunnableConfig;
        metadata?: Metadata;
      }
    ) {
      const threadId = config.configurable?.thread_id;
      if (!threadId) return [];

      const thread = await Threads.get(threadId);
      const graphId = thread.metadata?.graph_id as string | undefined | null;
      if (graphId == null) return [];

      const graph = await getGraph(graphId, { checkpointer, store });
      const before: RunnableConfig | undefined =
        typeof options?.before === "string"
          ? { configurable: { checkpoint_id: options.before } }
          : options?.before;

      const states: LangGraphStateSnapshot[] = [];
      for await (const state of graph.getStateHistory(config, {
        limit: options?.limit ?? 10,
        before,
        filter: options?.metadata,
      })) {
        states.push(state);
      }

      return states;
    }
  };
}

export class Runs {
  static async *next(): AsyncGenerator<[Run, number] | null> {
    const now = new Date();
    const pendingRuns = Object.values(STORE.runs)
      .filter((run) => run.status === "pending" && run.created_at < now)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

    if (!pendingRuns.length) {
      yield null;
      return;
    }

    for (const run of pendingRuns) {
      const runId = run.run_id;
      const threadId = run.thread_id;

      const thread = STORE.threads[threadId];

      if (!thread) {
        await console.warn(
          `Unexpected missing thread in Runs.next: ${threadId}`
        );
        continue;
      }

      yield [run, 1];
    }
  }

  static async put(
    assistantId: string,
    kwargs: Record<string, unknown>,
    options?: {
      threadId?: string;
      userId?: string;
      runId?: string;
      status?: RunStatus;
      metadata?: Metadata;
      preventInsertInInflight?: boolean;
      multitaskStrategy?: MultitaskStrategy;
      ifNotExists?: IfNotExists;
      afterSeconds?: number;
    }
  ): Promise<Run[]> {
    const assistant = STORE.assistants[assistantId];
    if (!assistant) return [];

    const ifNotExists = options?.ifNotExists ?? "reject";
    const multitaskStrategy = options?.multitaskStrategy ?? "reject";
    const afterSeconds = options?.afterSeconds ?? 0;
    const status = options?.status ?? "pending";

    let threadId = options?.threadId;
    let runId = options?.runId;
    const metadata = options?.metadata ?? {};
    const config: RunnableConfig = metadata.config ?? {};

    const existingThread = Object.values(STORE.threads).find(
      (thread) => thread.thread_id === threadId
    );

    const now = new Date();

    if (!existingThread && (threadId == null || ifNotExists === "create")) {
      threadId ??= uuid();
      const thread: Thread = {
        thread_id: threadId,
        status: "busy",
        metadata: { graph_id: assistant.graph_id },
        config: Object.assign({}, assistant.config, config, {
          configurable: Object.assign(
            {},
            assistant.config.configurable,
            config.configurable
          ),
        }),
        created_at: now,
        updated_at: now,
      };
      STORE.threads[threadId] = thread;
    } else if (existingThread) {
      if (existingThread.status !== "busy") {
        existingThread.status = "busy";
        existingThread.metadata = Object.assign({}, existingThread.metadata, {
          graph_id: assistant.graph_id,
        });

        existingThread.config = Object.assign(
          {},
          assistant.config,
          existingThread.config,
          config,
          {
            configurable: Object.assign(
              {},
              assistant.config?.configurable,
              existingThread?.config?.configurable,
              config?.configurable
            ),
          }
        );

        existingThread.updated_at = now;
      }
    } else {
      return [];
    }

    // check for inflight runs if needed

    if (options?.preventInsertInInflight) {
      const inflightRuns = Object.values(STORE.runs).filter(
        (run) => run.thread_id === threadId && run.status === "pending"
      );

      if (inflightRuns.length > 0) {
        return inflightRuns;
      }
    }

    // create new run
    runId ??= uuid();

    const configurable = Object.assign(
      {},
      assistant.config.configurable,
      existingThread?.config?.configurable,
      config.configurable,
      {
        run_id: runId,
        thread_id: threadId,
        graph_id: assistant.graph_id,
        assistant_id: assistantId,
        user_id:
          config.configurable?.user_id ??
          existingThread?.config?.configurable?.user_id ??
          assistant.config?.configurable?.user_id ??
          options?.userId,
      }
    );

    const mergedMetadata = Object.assign(
      {},
      assistant.metadata,
      existingThread?.metadata,
      metadata
    );

    const newRun: Run = {
      run_id: runId,
      thread_id: threadId!,
      assistant_id: assistantId,
      metadata: mergedMetadata,
      status: status,
      kwargs: Object.assign({}, kwargs, {
        config: Object.assign(
          {},
          assistant.config,
          config,
          { configurable },
          { metadata: mergedMetadata }
        ),
      }),
      multitask_strategy: multitaskStrategy,
      created_at: new Date(now.valueOf() + afterSeconds * 1000),
      updated_at: now,
    };

    STORE.runs[runId] = newRun;
    return [newRun];
  }

  static async get(options: {
    run_id: string;
    thread_id: string;
  }): Promise<Run | null> {
    const run = STORE.runs[options.run_id];
    if (
      !run ||
      run.run_id !== options.run_id ||
      run.thread_id !== options.thread_id
    )
      return null;
    return run;
  }

  static async delete(options: {
    run_id: string;
    thread_id: string;
  }): Promise<string | null> {
    const run = STORE.runs[options.run_id];
    if (!run || run.thread_id !== options.thread_id)
      throw new Error("Run not found");

    delete STORE.runs[options.run_id];
    return run.run_id;
  }

  static async join(options: { run_id: string; thread_id: string }) {}
  static async cancel(
    runIds: string[],
    options: {
      action?: "interrupt" | "rollback";
      thread_id: string;
    }
  ) {}
  static async search(
    threadId: string,
    options?: {
      limit?: number;
      offset?: number;
      metadata?: Metadata;
    }
  ) {}
  static async setStatus(runId: string, status: RunStatus) {}

  static Stream = class {
    static subscribe(runId: string) {
      // const queue = new asyncio.Queue();
      // STORE.streams[runId] = queue;
      // return queue;
    }

    static join(runId: string) {
      // const queue = this.subscribe(runId);
      // return queue.get();
    }

    static publish(runId: string, event: string, message: string) {
      // const queue = this.subscribe(runId);
      // queue.put(message);
    }
  };
}

export class Crons {}
