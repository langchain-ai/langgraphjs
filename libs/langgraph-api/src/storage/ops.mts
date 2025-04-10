import type {
  StateSnapshot as LangGraphStateSnapshot,
  CheckpointMetadata as LangGraphCheckpointMetadata,
  LangGraphRunnableConfig,
} from "@langchain/langgraph";

import { HTTPException } from "hono/http-exception";
import { v4 as uuid4, v5 as uuid5 } from "uuid";
import { getGraph, NAMESPACE_GRAPH } from "../graph/load.mjs";
import { checkpointer } from "./checkpoint.mjs";
import { store } from "./store.mjs";
import { logger } from "../logging.mjs";
import { serializeError } from "../utils/serde.mjs";
import { FileSystemPersistence } from "./persist.mjs";
import { getLangGraphCommand, type RunCommand } from "../command.mjs";
import { handleAuthEvent, isAuthMatching } from "../auth/custom.mjs";
import type { AuthContext } from "../auth/index.mjs";

export type Metadata = Record<string, unknown>;

export type ThreadStatus = "idle" | "busy" | "interrupted" | "error";

export type RunStatus =
  | "pending"
  | "running"
  | "error"
  | "success"
  | "timeout"
  | "interrupted";

export type StreamMode =
  | "values"
  | "messages"
  | "messages-tuple"
  | "custom"
  | "updates"
  | "events"
  | "debug";

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
  name: string | undefined;
}

export interface RunKwargs {
  input?: unknown;
  command?: RunCommand;

  stream_mode?: Array<StreamMode>;

  interrupt_before?: "*" | string[] | undefined;
  interrupt_after?: "*" | string[] | undefined;

  config?: RunnableConfig;

  subgraphs?: boolean;
  temporary?: boolean;

  // TODO: implement webhook
  webhook?: unknown;

  // TODO: implement feedback_keys
  feedback_keys?: string[] | undefined;

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

interface Store {
  runs: Record<string, Run>;
  threads: Record<string, Thread>;
  assistants: Record<string, Assistant>;
  assistant_versions: AssistantVersion[];
  retry_counter: Record<string, number>;
}

export const conn = new FileSystemPersistence<Store>(
  ".langgraphjs_ops.json",
  () => ({
    runs: {},
    threads: {},
    assistants: {},
    assistant_versions: [],
    retry_counter: {},
  }),
);

class TimeoutError extends Error {}
class AbortError extends Error {}

interface Message {
  topic: `run:${string}:stream:${string}`;
  data: unknown;
}

class Queue {
  private buffer: Message[] = [];
  private listeners: (() => void)[] = [];

  push(item: Message) {
    this.buffer.push(item);
    for (const listener of this.listeners) {
      listener();
    }
  }

  async get(options: { timeout: number; signal?: AbortSignal }) {
    if (this.buffer.length > 0) {
      return this.buffer.shift()!;
    }

    return await new Promise<void>((resolve, reject) => {
      let listener: (() => void) | undefined = undefined;

      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((l) => l !== listener);
        reject(new TimeoutError());
      }, options.timeout);

      listener = () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
        clearTimeout(timer);
        resolve();
      };

      // TODO: make sure we're not leaking callback here
      if (options.signal != null) {
        options.signal.addEventListener("abort", () => {
          this.listeners = this.listeners.filter((l) => l !== listener);
          clearTimeout(timer);
          reject(new AbortError());
        });
      }

      this.listeners.push(listener);
    }).then(() => this.buffer.shift()!);
  }
}

class CancellationAbortController extends AbortController {
  abort(reason: "rollback" | "interrupt") {
    super.abort(reason);
  }
}

class StreamManagerImpl {
  readers: Record<string, Queue> = {};
  control: Record<string, CancellationAbortController> = {};

  getQueue(runId: string, options: { ifNotFound: "create" }): Queue;

  getQueue(runId: string, options: { ifNotFound: "ignore" }): Queue | undefined;

  getQueue(runId: string, options: { ifNotFound: "create" | "ignore" }) {
    if (this.readers[runId] == null) {
      if (options?.ifNotFound === "create") {
        this.readers[runId] = new Queue();
      } else {
        return undefined;
      }
    }

    return this.readers[runId];
  }

  getControl(runId: string) {
    if (this.control[runId] == null) return undefined;
    return this.control[runId];
  }

  isLocked(runId: string): boolean {
    return this.control[runId] != null;
  }

  lock(runId: string): AbortSignal {
    if (this.control[runId] != null) {
      logger.warn("Run already locked", { run_id: runId });
    }
    this.control[runId] = new CancellationAbortController();
    return this.control[runId].signal;
  }

  unlock(runId: string) {
    delete this.control[runId];
  }
}

export const StreamManager = new StreamManagerImpl();

export const truncate = (flags: {
  runs?: boolean;
  threads?: boolean;
  assistants?: boolean;
  checkpointer?: boolean;
  store?: boolean;
}) => {
  return conn.with((STORE) => {
    if (flags.runs) STORE.runs = {};
    if (flags.threads) STORE.threads = {};
    if (flags.assistants) {
      STORE.assistants = Object.fromEntries(
        Object.entries(STORE.assistants).filter(
          ([key, assistant]) =>
            assistant.metadata?.created_by === "system" &&
            uuid5(assistant.graph_id, NAMESPACE_GRAPH) === key,
        ),
      );
    }

    if (flags.checkpointer) checkpointer.clear();
    if (flags.store) store.clear();
  });
};

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const isJsonbContained = (
  superset: Record<string, unknown> | undefined,
  subset: Record<string, unknown> | undefined,
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
  static async *search(
    options: {
      graph_id?: string;
      metadata?: Metadata;
      limit: number;
      offset: number;
    },
    auth: AuthContext | undefined,
  ) {
    const [filters] = await handleAuthEvent(auth, "assistants:search", {
      graph_id: options.graph_id,
      metadata: options.metadata,
      limit: options.limit,
      offset: options.offset,
    });

    yield* conn.withGenerator(async function* (STORE) {
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

          if (!isAuthMatching(assistant["metadata"], filters)) {
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
        options.offset + options.limit,
      )) {
        yield { ...assistant, name: assistant.name ?? assistant.graph_id };
      }
    });
  }

  static async get(
    assistant_id: string,
    auth: AuthContext | undefined,
  ): Promise<Assistant> {
    const [filters] = await handleAuthEvent(auth, "assistants:read", {
      assistant_id,
    });

    return conn.with((STORE) => {
      const result = STORE.assistants[assistant_id];
      if (result == null)
        throw new HTTPException(404, { message: "Assistant not found" });
      if (!isAuthMatching(result["metadata"], filters)) {
        throw new HTTPException(404, { message: "Assistant not found" });
      }
      return { ...result, name: result.name ?? result.graph_id };
    });
  }

  static async put(
    assistant_id: string,
    options: {
      config: RunnableConfig;
      graph_id: string;
      metadata?: Metadata;
      if_exists: OnConflictBehavior;
      name?: string;
    },
    auth: AuthContext | undefined,
  ): Promise<Assistant> {
    const [filters, mutable] = await handleAuthEvent(
      auth,
      "assistants:create",
      {
        assistant_id,
        config: options.config,
        graph_id: options.graph_id,
        metadata: options.metadata,
        if_exists: options.if_exists,
        name: options.name,
      },
    );

    return conn.with((STORE) => {
      if (STORE.assistants[assistant_id] != null) {
        const existingAssistant = STORE.assistants[assistant_id];

        if (!isAuthMatching(existingAssistant?.metadata, filters)) {
          throw new HTTPException(409, { message: "Assistant already exists" });
        }

        if (options.if_exists === "raise") {
          throw new HTTPException(409, { message: "Assistant already exists" });
        }

        return existingAssistant;
      }

      const now = new Date();

      STORE.assistants[assistant_id] ??= {
        assistant_id: assistant_id,
        version: 1,
        config: options.config ?? {},
        created_at: now,
        updated_at: now,
        graph_id: options.graph_id,
        metadata: mutable.metadata ?? ({} as Metadata),
        name: options.name || options.graph_id,
      };

      STORE.assistant_versions.push({
        assistant_id: assistant_id,
        version: 1,
        graph_id: options.graph_id,
        config: options.config ?? {},
        metadata: mutable.metadata ?? ({} as Metadata),
        created_at: now,
        name: options.name || options.graph_id,
      });

      return STORE.assistants[assistant_id];
    });
  }

  static async patch(
    assistantId: string,
    options: {
      config?: RunnableConfig;
      graph_id?: string;
      metadata?: Metadata;
      name?: string;
    },
    auth: AuthContext | undefined,
  ): Promise<Assistant> {
    const [filters, mutable] = await handleAuthEvent(
      auth,
      "assistants:update",
      {
        assistant_id: assistantId,
        graph_id: options?.graph_id,
        config: options?.config,
        metadata: options?.metadata,
        name: options?.name,
      },
    );

    return conn.with((STORE) => {
      const assistant = STORE.assistants[assistantId];
      if (!assistant) {
        throw new HTTPException(404, { message: "Assistant not found" });
      }

      if (!isAuthMatching(assistant["metadata"], filters)) {
        throw new HTTPException(404, { message: "Assistant not found" });
      }

      const now = new Date();

      const metadata =
        mutable.metadata != null
          ? {
              ...assistant["metadata"],
              ...mutable.metadata,
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
            .map((v) => v["version"]),
        ) + 1;

      assistant.version = newVersion;

      const newVersionEntry = {
        assistant_id: assistantId,
        version: newVersion,
        graph_id: options?.graph_id ?? assistant["graph_id"],
        config: options?.config ?? assistant["config"],
        name: options?.name ?? assistant["name"],
        metadata: metadata ?? assistant["metadata"],
        created_at: now,
      };

      STORE.assistant_versions.push(newVersionEntry);
      return assistant;
    });
  }

  static async delete(
    assistant_id: string,
    auth: AuthContext | undefined,
  ): Promise<string[]> {
    const [filters] = await handleAuthEvent(auth, "assistants:delete", {
      assistant_id,
    });

    return conn.with((STORE) => {
      const assistant = STORE.assistants[assistant_id];
      if (!assistant) {
        throw new HTTPException(404, { message: "Assistant not found" });
      }

      if (!isAuthMatching(assistant["metadata"], filters)) {
        throw new HTTPException(404, { message: "Assistant not found" });
      }

      delete STORE.assistants[assistant_id];

      // Cascade delete for assistant versions and crons
      STORE.assistant_versions = STORE.assistant_versions.filter(
        (v) => v["assistant_id"] !== assistant_id,
      );

      for (const run of Object.values(STORE.runs)) {
        if (run["assistant_id"] === assistant_id) {
          delete STORE.runs[run["run_id"]];
        }
      }

      return [assistant.assistant_id];
    });
  }

  static async setLatest(
    assistant_id: string,
    version: number,
    auth: AuthContext | undefined,
  ): Promise<Assistant> {
    const [filters] = await handleAuthEvent(auth, "assistants:update", {
      assistant_id,
      version,
    });

    return conn.with((STORE) => {
      const assistant = STORE.assistants[assistant_id];
      if (!assistant) {
        throw new HTTPException(404, { message: "Assistant not found" });
      }

      if (!isAuthMatching(assistant["metadata"], filters)) {
        throw new HTTPException(404, { message: "Assistant not found" });
      }

      const assistantVersion = STORE.assistant_versions.find(
        (v) => v["assistant_id"] === assistant_id && v["version"] === version,
      );

      if (!assistantVersion)
        throw new HTTPException(404, {
          message: "Assistant version not found",
        });

      const now = new Date();
      STORE.assistants[assistant_id] = {
        ...assistant,
        config: assistantVersion["config"],
        metadata: assistantVersion["metadata"],
        version: assistantVersion["version"],
        name: assistantVersion["name"],
        updated_at: now,
      };

      return STORE.assistants[assistant_id];
    });
  }

  static async getVersions(
    assistant_id: string,
    options: {
      limit: number;
      offset: number;
      metadata?: Metadata;
    },
    auth: AuthContext | undefined,
  ) {
    const [filters] = await handleAuthEvent(auth, "assistants:read", {
      assistant_id,
    });

    return conn.with((STORE) => {
      const versions = STORE.assistant_versions
        .filter((version) => {
          if (version["assistant_id"] !== assistant_id) return false;

          if (
            options.metadata != null &&
            !isJsonbContained(version["metadata"], options.metadata)
          ) {
            return false;
          }

          if (!isAuthMatching(version["metadata"], filters)) {
            return false;
          }

          return true;
        })
        .sort((a, b) => b["version"] - a["version"]);

      return versions.slice(options.offset, options.offset + options.limit);
    });
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
  error: string | null;
  interrupts: Record<string, unknown>[];
  checkpoint: Checkpoint | null;
  state: ThreadState | null;
  result: Record<string, unknown> | null;
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
  static async *search(
    options: {
      metadata?: Metadata;
      status?: ThreadStatus;
      values?: Record<string, unknown>;
      limit: number;
      offset: number;
    },
    auth: AuthContext | undefined,
  ): AsyncGenerator<Thread> {
    const [filters] = await handleAuthEvent(auth, "threads:search", {
      metadata: options.metadata,
      status: options.status,
      values: options.values,
      limit: options.limit,
      offset: options.offset,
    });

    yield* conn.withGenerator(async function* (STORE) {
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

          if (!isAuthMatching(thread["metadata"], filters)) return false;

          return true;
        })
        .sort((a, b) => b["created_at"].getTime() - a["created_at"].getTime());

      for (const thread of filtered.slice(
        options.offset,
        options.offset + options.limit,
      )) {
        yield thread;
      }
    });
  }

  // TODO: make this accept `undefined`
  static async get(
    thread_id: string,
    auth: AuthContext | undefined,
  ): Promise<Thread> {
    const [filters] = await handleAuthEvent(auth, "threads:read", {
      thread_id,
    });

    return conn.with((STORE) => {
      const result = STORE.threads[thread_id];
      if (result == null) {
        throw new HTTPException(404, {
          message: `Thread with ID ${thread_id} not found`,
        });
      }

      if (!isAuthMatching(result["metadata"], filters)) {
        throw new HTTPException(404, {
          message: `Thread with ID ${thread_id} not found`,
        });
      }

      return result;
    });
  }

  static async put(
    thread_id: string,
    options: {
      metadata?: Metadata;
      if_exists: OnConflictBehavior;
    },
    auth: AuthContext | undefined,
  ): Promise<Thread> {
    const [filters, mutable] = await handleAuthEvent(auth, "threads:create", {
      thread_id,
      metadata: options.metadata,
      if_exists: options.if_exists,
    });

    return conn.with((STORE) => {
      const now = new Date();

      if (STORE.threads[thread_id] != null) {
        const existingThread = STORE.threads[thread_id];

        if (!isAuthMatching(existingThread["metadata"], filters)) {
          throw new HTTPException(409, { message: "Thread already exists" });
        }

        if (options?.if_exists === "raise") {
          throw new HTTPException(409, { message: "Thread already exists" });
        }

        return existingThread;
      }

      STORE.threads[thread_id] ??= {
        thread_id: thread_id,
        created_at: now,
        updated_at: now,
        metadata: mutable?.metadata ?? {},
        status: "idle",
        config: {},
        values: undefined,
      };

      return STORE.threads[thread_id];
    });
  }

  static async patch(
    threadId: string,
    options: { metadata?: Metadata },
    auth: AuthContext | undefined,
  ): Promise<Thread> {
    const [filters, mutable] = await handleAuthEvent(auth, "threads:update", {
      thread_id: threadId,
      metadata: options.metadata,
    });

    return conn.with((STORE) => {
      const thread = STORE.threads[threadId];
      if (!thread) {
        throw new HTTPException(404, { message: "Thread not found" });
      }

      if (!isAuthMatching(thread["metadata"], filters)) {
        // TODO: is this correct status code?
        throw new HTTPException(404, { message: "Thread not found" });
      }

      const now = new Date();
      if (mutable.metadata != null) {
        thread["metadata"] = {
          ...thread["metadata"],
          ...mutable.metadata,
        };
      }

      thread["updated_at"] = now;
      return thread;
    });
  }

  static async setStatus(
    threadId: string,
    options: {
      checkpoint?: CheckpointPayload;
      exception?: Error;
    },
  ) {
    return conn.with((STORE) => {
      const thread = STORE.threads[threadId];
      if (!thread)
        throw new HTTPException(404, { message: "Thread not found" });

      let hasNext = false;
      if (options.checkpoint != null) {
        hasNext = options.checkpoint.next.length > 0;
      }

      const hasPendingRuns = Object.values(STORE.runs).some(
        (run) => run["thread_id"] === threadId && run["status"] === "pending",
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
              {},
            )
          : undefined;
    });
  }

  static async delete(
    thread_id: string,
    auth: AuthContext | undefined,
  ): Promise<string[]> {
    const [filters] = await handleAuthEvent(auth, "threads:delete", {
      thread_id,
    });

    return conn.with((STORE) => {
      const thread = STORE.threads[thread_id];
      if (!thread) {
        throw new HTTPException(404, {
          message: `Thread with ID ${thread_id} not found`,
        });
      }

      if (!isAuthMatching(thread["metadata"], filters)) {
        throw new HTTPException(404, {
          message: `Thread with ID ${thread_id} not found`,
        });
      }

      delete STORE.threads[thread_id];
      for (const run of Object.values(STORE.runs)) {
        if (run["thread_id"] === thread_id) {
          delete STORE.runs[run["run_id"]];
        }
      }
      checkpointer.delete(thread_id, null);

      return [thread.thread_id];
    });
  }

  static async copy(
    thread_id: string,
    auth: AuthContext | undefined,
  ): Promise<Thread> {
    const [filters] = await handleAuthEvent(auth, "threads:read", {
      thread_id,
    });

    return conn.with((STORE) => {
      const thread = STORE.threads[thread_id];
      if (!thread)
        throw new HTTPException(409, { message: "Thread not found" });

      if (!isAuthMatching(thread["metadata"], filters)) {
        throw new HTTPException(409, { message: "Thread not found" });
      }

      const newThreadId = uuid4();
      const now = new Date();
      STORE.threads[newThreadId] = {
        thread_id: newThreadId,
        created_at: now,
        updated_at: now,
        metadata: { ...thread.metadata, thread_id: newThreadId },
        config: {},
        status: "idle",
      };

      checkpointer.copy(thread_id, newThreadId);
      return STORE.threads[newThreadId];
    });
  }

  static State = class {
    static async get(
      config: RunnableConfig,
      options: { subgraphs?: boolean },
      auth: AuthContext | undefined,
    ): Promise<LangGraphStateSnapshot> {
      const subgraphs = options.subgraphs ?? false;
      const threadId = config.configurable?.thread_id;
      const thread = threadId ? await Threads.get(threadId, auth) : undefined;

      const metadata = thread?.metadata ?? {};
      const graphId = metadata?.graph_id as string | undefined | null;

      if (!thread || graphId == null) {
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

      const graph = await getGraph(graphId, thread.config, {
        checkpointer,
        store,
      });
      const result = await graph.getState(config, { subgraphs });

      if (
        result.metadata != null &&
        "checkpoint_ns" in result.metadata &&
        result.metadata["checkpoint_ns"] === ""
      ) {
        delete result.metadata["checkpoint_ns"];
      }
      return result;
    }

    static async post(
      config: RunnableConfig,
      values:
        | Record<string, unknown>[]
        | Record<string, unknown>
        | null
        | undefined,
      asNode: string | undefined,
      auth: AuthContext | undefined,
    ) {
      const threadId = config.configurable?.thread_id;
      const [filters] = await handleAuthEvent(auth, "threads:update", {
        thread_id: threadId,
      });

      const thread = threadId ? await Threads.get(threadId, auth) : undefined;
      if (!thread)
        throw new HTTPException(404, {
          message: `Thread ${threadId} not found`,
        });

      if (!isAuthMatching(thread["metadata"], filters)) {
        throw new HTTPException(403);
      }

      const graphId = thread.metadata?.graph_id as string | undefined | null;

      if (graphId == null) {
        throw new HTTPException(400, {
          message: `Thread ${threadId} has no graph ID`,
        });
      }

      config.configurable ??= {};
      config.configurable.graph_id ??= graphId;

      const graph = await getGraph(graphId, thread.config, {
        checkpointer,
        store,
      });

      const updateConfig = structuredClone(config);
      updateConfig.configurable ??= {};
      updateConfig.configurable.checkpoint_ns ??= "";

      const nextConfig = await graph.updateState(updateConfig, values, asNode);
      const state = await Threads.State.get(config, { subgraphs: false }, auth);

      // update thread values
      await conn.with(async (STORE) => {
        for (const thread of Object.values(STORE.threads)) {
          if (thread.thread_id === threadId) {
            thread.values = state.values;
            break;
          }
        }
      });

      return { checkpoint: nextConfig.configurable };
    }

    static async bulk(
      config: RunnableConfig,
      supersteps: Array<{
        updates: Array<{
          values?:
            | Record<string, unknown>[]
            | Record<string, unknown>
            | unknown
            | null
            | undefined;
          command?: RunCommand | undefined | null;
          as_node?: string | undefined;
        }>;
      }>,
      auth: AuthContext | undefined,
    ) {
      const threadId = config.configurable?.thread_id;
      if (!threadId) return [];

      const [filters] = await handleAuthEvent(auth, "threads:update", {
        thread_id: threadId,
      });

      const thread = await Threads.get(threadId, auth);

      if (!isAuthMatching(thread["metadata"], filters)) {
        throw new HTTPException(403);
      }

      const graphId = thread.metadata?.graph_id as string | undefined | null;
      if (graphId == null) {
        throw new HTTPException(400, {
          message: `Thread ${threadId} has no graph ID`,
        });
      }

      config.configurable ??= {};
      config.configurable.graph_id ??= graphId;

      const graph = await getGraph(graphId, thread.config, {
        checkpointer,
        store,
      });

      const updateConfig = structuredClone(config);
      updateConfig.configurable ??= {};
      updateConfig.configurable.checkpoint_ns ??= "";

      const nextConfig = await graph.bulkUpdateState(
        updateConfig,
        supersteps.map((i) => ({
          updates: i.updates.map((j) => ({
            values:
              j.command != null ? getLangGraphCommand(j.command) : j.values,
            asNode: j.as_node,
          })),
        })),
      );
      const state = await Threads.State.get(config, { subgraphs: false }, auth);

      // update thread values
      await conn.with(async (STORE) => {
        for (const thread of Object.values(STORE.threads)) {
          if (thread.thread_id === threadId) {
            thread.values = state.values;
            break;
          }
        }
      });

      return { checkpoint: nextConfig.configurable };
    }

    static async list(
      config: RunnableConfig,
      options: {
        limit?: number;
        before?: string | RunnableConfig;
        metadata?: Metadata;
      },
      auth: AuthContext | undefined,
    ) {
      const threadId = config.configurable?.thread_id;
      if (!threadId) return [];

      const [filters] = await handleAuthEvent(auth, "threads:read", {
        thread_id: threadId,
      });

      const thread = await Threads.get(threadId, auth);
      if (!isAuthMatching(thread["metadata"], filters)) return [];

      const graphId = thread.metadata?.graph_id as string | undefined | null;
      if (graphId == null) return [];

      const graph = await getGraph(graphId, thread.config, {
        checkpointer,
        store,
      });
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
  static async *next(): AsyncGenerator<{
    run: Run;
    attempt: number;
    signal: AbortSignal;
  }> {
    yield* conn.withGenerator(async function* (STORE, options) {
      const now = new Date();
      const pendingRuns = Object.values(STORE.runs)
        .filter((run) => run.status === "pending" && run.created_at < now)
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

      if (!pendingRuns.length) {
        return;
      }

      for (const run of pendingRuns) {
        const runId = run.run_id;
        const threadId = run.thread_id;
        const thread = STORE.threads[threadId];

        if (!thread) {
          await console.warn(
            `Unexpected missing thread in Runs.next: ${threadId}`,
          );
          continue;
        }

        if (StreamManager.isLocked(runId)) continue;
        try {
          const signal = StreamManager.lock(runId);

          options.schedulePersist();
          STORE.retry_counter[runId] ??= 0;
          STORE.retry_counter[runId] += 1;

          yield { run, attempt: STORE.retry_counter[runId], signal };
        } finally {
          StreamManager.unlock(runId);
        }
      }
    });
  }

  static async put(
    runId: string,
    assistantId: string,
    kwargs: RunKwargs,
    options: {
      threadId?: string;
      userId?: string;
      status?: RunStatus;
      metadata?: Metadata;
      preventInsertInInflight?: boolean;
      multitaskStrategy?: MultitaskStrategy;
      ifNotExists?: IfNotExists;
      afterSeconds?: number;
    },
    auth: AuthContext | undefined,
  ): Promise<Run[]> {
    return conn.with(async (STORE) => {
      const assistant = STORE.assistants[assistantId];
      if (!assistant) {
        throw new HTTPException(404, {
          message: `No assistant found for "${assistantId}". Make sure the assistant ID is for a valid assistant or a valid graph ID.`,
        });
      }

      const ifNotExists = options?.ifNotExists ?? "reject";
      const multitaskStrategy = options?.multitaskStrategy ?? "reject";
      const afterSeconds = options?.afterSeconds ?? 0;
      const status = options?.status ?? "pending";

      let threadId = options?.threadId;

      const [filters, mutable] = await handleAuthEvent(
        auth,
        "threads:create_run",
        {
          thread_id: threadId,
          assistant_id: assistantId,
          run_id: runId,
          status: status,
          metadata: options?.metadata ?? {},
          prevent_insert_if_inflight: options?.preventInsertInInflight,
          multitask_strategy: multitaskStrategy,
          if_not_exists: ifNotExists,
          after_seconds: afterSeconds,
          kwargs,
        },
      );

      const metadata = mutable.metadata ?? {};
      const config: RunnableConfig = kwargs.config ?? {};

      const existingThread = Object.values(STORE.threads).find(
        (thread) => thread.thread_id === threadId,
      );

      if (
        existingThread &&
        !isAuthMatching(existingThread["metadata"], filters)
      ) {
        throw new HTTPException(404);
      }

      const now = new Date();

      if (!existingThread && (threadId == null || ifNotExists === "create")) {
        threadId ??= uuid4();
        const thread: Thread = {
          thread_id: threadId,
          status: "busy",
          metadata: {
            graph_id: assistant.graph_id,
            assistant_id: assistantId,
            ...metadata,
          },
          config: Object.assign({}, assistant.config, config, {
            configurable: Object.assign(
              {},
              assistant.config?.configurable,
              config?.configurable,
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
            assistant_id: assistantId,
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
                config?.configurable,
              ),
            },
          );

          existingThread.updated_at = now;
        }
      } else {
        return [];
      }

      // if multitask_mode = reject, check for inflight runs
      // and if there are any, return them to reject putting a new run
      const inflightRuns = Object.values(STORE.runs).filter(
        (run) => run.thread_id === threadId && run.status === "pending",
      );

      if (options?.preventInsertInInflight) {
        if (inflightRuns.length > 0) return inflightRuns;
      }

      // create new run
      const configurable = Object.assign(
        {},
        assistant.config?.configurable,
        existingThread?.config?.configurable,
        config?.configurable,
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
        },
      );

      const mergedMetadata = Object.assign(
        {},
        assistant.metadata,
        existingThread?.metadata,
        metadata,
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
            { metadata: mergedMetadata },
          ),
        }),
        multitask_strategy: multitaskStrategy,
        created_at: new Date(now.valueOf() + afterSeconds * 1000),
        updated_at: now,
      };

      STORE.runs[runId] = newRun;
      return [newRun, ...inflightRuns];
    });
  }

  static async get(
    runId: string,
    thread_id: string | undefined,
    auth: AuthContext | undefined,
  ): Promise<Run | null> {
    const [filters] = await handleAuthEvent(auth, "threads:read", {
      thread_id,
    });

    return conn.with(async (STORE) => {
      const run = STORE.runs[runId];
      if (
        !run ||
        run.run_id !== runId ||
        (thread_id != null && run.thread_id !== thread_id)
      )
        return null;

      if (filters != null) {
        const thread = STORE.threads[run.thread_id];
        if (!isAuthMatching(thread["metadata"], filters)) return null;
      }

      return run;
    });
  }

  static async delete(
    run_id: string,
    thread_id: string | undefined,
    auth: AuthContext | undefined,
  ): Promise<string | null> {
    const [filters] = await handleAuthEvent(auth, "threads:delete", {
      run_id,
      thread_id,
    });

    return conn.with(async (STORE) => {
      const run = STORE.runs[run_id];
      if (!run || (thread_id != null && run.thread_id !== thread_id))
        throw new HTTPException(404, { message: "Run not found" });

      if (filters != null) {
        const thread = STORE.threads[run.thread_id];
        if (!isAuthMatching(thread["metadata"], filters)) {
          throw new HTTPException(404, { message: "Run not found" });
        }
      }

      if (thread_id != null) checkpointer.delete(thread_id, run_id);
      delete STORE.runs[run_id];
      return run.run_id;
    });
  }

  static async wait(
    runId: string,
    threadId: string | undefined,
    auth: AuthContext | undefined,
  ) {
    const runStream = Runs.Stream.join(
      runId,
      threadId,
      { ignore404: threadId == null },
      auth,
    );

    const lastChunk = new Promise(async (resolve, reject) => {
      try {
        let lastChunk: unknown = null;
        for await (const { event, data } of runStream) {
          if (event === "values") {
            lastChunk = data as Record<string, unknown>;
          } else if (event === "error") {
            lastChunk = { __error__: serializeError(data) };
          }
        }

        resolve(lastChunk);
      } catch (error) {
        reject(error);
      }
    });

    return lastChunk;
  }

  static async join(
    runId: string,
    threadId: string,
    auth: AuthContext | undefined,
  ) {
    // check if thread exists
    await Threads.get(threadId, auth);

    const lastChunk = await Runs.wait(runId, threadId, auth);
    if (lastChunk != null) return lastChunk;

    const thread = await Threads.get(threadId, auth);
    return thread.values;
  }

  static async cancel(
    threadId: string | undefined,
    runIds: string[],
    options: {
      action?: "interrupt" | "rollback";
    },
    auth: AuthContext | undefined,
  ) {
    return conn.with(async (STORE) => {
      const action = options.action ?? "interrupt";
      const promises: Promise<unknown>[] = [];

      const [filters] = await handleAuthEvent(auth, "threads:update", {
        thread_id: threadId,
        action,
        metadata: { run_ids: runIds, status: "pending" },
      });

      let foundRunsCount = 0;

      for (const runId of runIds) {
        const run = STORE.runs[runId];
        if (!run || (threadId != null && run.thread_id !== threadId)) continue;

        if (filters != null) {
          const thread = STORE.threads[run.thread_id];
          if (!isAuthMatching(thread["metadata"], filters)) continue;
        }

        foundRunsCount += 1;

        // send cancellation message
        const control = StreamManager.getControl(runId);
        control?.abort(options.action ?? "interrupt");

        if (run.status === "pending") {
          if (control || action !== "rollback") {
            run.status = "interrupted";
            run.updated_at = new Date();
          } else {
            logger.info(
              "Eagerly deleting unscheduled run with rollback action",
              {
                run_id: runId,
                thread_id: threadId,
              },
            );

            promises.push(Runs.delete(runId, threadId, auth));
          }
        } else {
          logger.warn("Attempted to cancel non-pending run.", {
            run_id: runId,
            status: run.status,
          });
        }
      }

      await Promise.all(promises);

      if (foundRunsCount === runIds.length) {
        logger.info("Cancelled runs", {
          run_ids: runIds,
          thread_id: threadId,
          action,
        });
      } else {
        throw new HTTPException(404, { message: "Run not found" });
      }
    });
  }

  static async search(
    threadId: string,
    options: {
      limit?: number | null;
      offset?: number | null;
      status?: string | null;
      metadata?: Metadata | null;
    },
    auth: AuthContext | undefined,
  ) {
    const [filters] = await handleAuthEvent(auth, "threads:search", {
      thread_id: threadId,
      metadata: options.metadata,
      status: options.status,
    });

    return conn.with(async (STORE) => {
      const runs = Object.values(STORE.runs).filter((run) => {
        if (run.thread_id !== threadId) return false;
        if (options?.status != null && run.status !== options.status)
          return false;
        if (
          options?.metadata != null &&
          !isJsonbContained(run.metadata, options.metadata)
        )
          return false;

        if (filters != null) {
          const thread = STORE.threads[run.thread_id];
          if (!isAuthMatching(thread["metadata"], filters)) return false;
        }
        return true;
      });

      return runs.slice(options?.offset ?? 0, options?.limit ?? 10);
    });
  }

  static async setStatus(runId: string, status: RunStatus) {
    return conn.with(async (STORE) => {
      const run = STORE.runs[runId];
      if (!run) throw new Error(`Run ${runId} not found`);
      run.status = status;
      run.updated_at = new Date();
    });
  }

  static Stream = class {
    static async *join(
      runId: string,
      threadId: string | undefined,
      options: {
        ignore404?: boolean;
        cancelOnDisconnect?: AbortSignal;
      },
      auth: AuthContext | undefined,
    ): AsyncGenerator<{ event: string; data: unknown }> {
      yield* conn.withGenerator(async function* (STORE) {
        // TODO: what if we're joining an already completed run? Should we check before?
        const signal = options?.cancelOnDisconnect;
        const queue = StreamManager.getQueue(runId, { ifNotFound: "create" });

        const [filters] = await handleAuthEvent(auth, "threads:read", {
          thread_id: threadId,
        });

        // TODO: consolidate into a single function
        if (filters != null && threadId != null) {
          const thread = STORE.threads[threadId];
          if (!isAuthMatching(thread["metadata"], filters)) {
            yield {
              event: "error",
              data: { error: "Error", message: "404: Thread not found" },
            };
            return;
          }
        }

        while (!signal?.aborted) {
          try {
            const message = await queue.get({ timeout: 500, signal });
            if (message.topic === `run:${runId}:control`) {
              if (message.data === "done") break;
            } else {
              const streamTopic = message.topic.substring(
                `run:${runId}:stream:`.length,
              );

              yield { event: streamTopic, data: message.data };
            }
          } catch (error) {
            if (error instanceof AbortError) break;

            const run = await Runs.get(runId, threadId, auth);
            if (run == null) {
              if (!options?.ignore404)
                yield { event: "error", data: "Run not found" };
              break;
            } else if (run.status !== "pending") {
              break;
            }
          }
        }

        if (signal?.aborted && threadId != null) {
          await Runs.cancel(threadId, [runId], { action: "interrupt" }, auth);
        }
      });
    }

    static async publish(runId: string, topic: string, data: unknown) {
      const queue = StreamManager.getQueue(runId, { ifNotFound: "create" });
      queue.push({ topic: `run:${runId}:stream:${topic}`, data });
    }
  };
}

export class Crons {}
