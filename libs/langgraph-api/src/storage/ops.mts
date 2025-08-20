import type {
  CheckpointMetadata as LangGraphCheckpointMetadata,
  LangGraphRunnableConfig,
  StateSnapshot as LangGraphStateSnapshot,
} from "@langchain/langgraph";

import { HTTPException } from "hono/http-exception";
import { v4 as uuid4, v5 as uuid5 } from "uuid";
import { handleAuthEvent, isAuthMatching } from "../auth/custom.mjs";
import type { AuthContext } from "../auth/index.mjs";
import { getLangGraphCommand, type RunCommand } from "../command.mjs";
import { getGraph, NAMESPACE_GRAPH } from "../graph/load.mjs";
import { logger } from "../logging.mjs";
import { serializeError } from "../utils/serde.mjs";
import { checkpointer } from "./checkpoint.mjs";
import { FileSystemPersistence } from "./persist.mjs";
import { store } from "./store.mjs";
import type {
  Metadata,
  ThreadStatus,
  RunStatus,
  MultitaskStrategy,
  OnConflictBehavior,
  IfNotExists,
  RunnableConfig,
  Assistant,
  RunKwargs,
  Run,
  Store,
  Message,
  Thread,
  CheckpointPayload,
} from "./types.mjs";

export const conn = new FileSystemPersistence<Store>(
  ".langgraphjs_ops.json",
  () => ({
    runs: {},
    threads: {},
    assistants: {},
    assistant_versions: [],
    retry_counter: {},
  })
);

class TimeoutError extends Error {}
class AbortError extends Error {}

class Queue {
  private log: Message[] = [];
  private listeners: ((idx: number) => void)[] = [];

  private nextId = 0;
  private resumable = false;

  constructor(options: { resumable: boolean }) {
    this.resumable = options.resumable;
  }

  push(item: Message) {
    this.log.push(item);
    for (const listener of this.listeners) listener(this.nextId);
    this.nextId += 1;
  }

  async get(options: {
    timeout: number;
    lastEventId?: string;
    signal?: AbortSignal;
  }): Promise<[id: string, message: Message]> {
    if (this.resumable) {
      const lastEventId = options.lastEventId;

      // Generator stores internal state of the read head index,
      let targetId = lastEventId != null ? +lastEventId + 1 : null;
      if (
        targetId == null ||
        isNaN(targetId) ||
        targetId < 0 ||
        targetId >= this.log.length
      ) {
        targetId = null;
      }

      if (targetId != null) return [String(targetId), this.log[targetId]];
    } else {
      if (this.log.length) {
        const nextId = this.nextId - this.log.length;
        const nextItem = this.log.shift()!;
        return [String(nextId), nextItem];
      }
    }

    let timeout: NodeJS.Timeout | undefined = undefined;
    let resolver: ((idx: number) => void) | undefined = undefined;

    const clean = new AbortController();

    // listen to new item
    return await new Promise<number>((resolve, reject) => {
      timeout = setTimeout(() => reject(new TimeoutError()), options.timeout);
      resolver = resolve;

      options.signal?.addEventListener(
        "abort",
        () => reject(new AbortError()),
        { signal: clean.signal }
      );

      this.listeners.push(resolver);
    })
      .then((idx) => {
        if (this.resumable) {
          return [String(idx), this.log[idx]] as [string, Message];
        }

        const nextId = this.nextId - this.log.length;
        const nextItem = this.log.shift()!;
        return [String(nextId), nextItem] as [string, Message];
      })
      .finally(() => {
        this.listeners = this.listeners.filter((l) => l !== resolver);
        clearTimeout(timeout);
        clean.abort();
      });
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

  getQueue(
    runId: string,
    options: { ifNotFound: "create"; resumable: boolean }
  ): Queue {
    if (this.readers[runId] == null) {
      this.readers[runId] = new Queue(options);
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
            uuid5(assistant.graph_id, NAMESPACE_GRAPH) === key
        )
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
  static async *search(
    options: {
      graph_id?: string;
      metadata?: Metadata;
      limit: number;
      offset: number;
    },
    auth: AuthContext | undefined
  ): AsyncGenerator<{ assistant: Assistant; total: number }> {
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

      // Calculate total count before pagination
      const total = filtered.length;

      for (const assistant of filtered.slice(
        options.offset,
        options.offset + options.limit
      )) {
        yield {
          assistant: {
            ...assistant,
            name: assistant.name ?? assistant.graph_id,
          },
          total,
        };
      }
    });
  }

  static async get(
    assistant_id: string,
    auth: AuthContext | undefined
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
      context: unknown;
      graph_id: string;
      metadata?: Metadata;
      if_exists: OnConflictBehavior;
      name?: string;
    },
    auth: AuthContext | undefined
  ): Promise<Assistant> {
    const [filters, mutable] = await handleAuthEvent(
      auth,
      "assistants:create",
      {
        assistant_id,
        config: options.config,
        context: options.context,
        graph_id: options.graph_id,
        metadata: options.metadata,
        if_exists: options.if_exists,
        name: options.name,
      }
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
        context: options.context ?? {},
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
        context: options.context ?? {},
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
      context?: unknown;
      graph_id?: string;
      metadata?: Metadata;
      name?: string;
    },
    auth: AuthContext | undefined
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
      }
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

      if (options?.context != null) {
        assistant["context"] = options?.context ?? assistant["context"];
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

      assistant.version = newVersion;

      const newVersionEntry = {
        assistant_id: assistantId,
        version: newVersion,
        graph_id: options?.graph_id ?? assistant["graph_id"],
        config: options?.config ?? assistant["config"],
        context: options?.context ?? assistant["context"],
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
    auth: AuthContext | undefined
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
        (v) => v["assistant_id"] !== assistant_id
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
    auth: AuthContext | undefined
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
        (v) => v["assistant_id"] === assistant_id && v["version"] === version
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
    auth: AuthContext | undefined
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

export class Threads {
  static async *search(
    options: {
      metadata?: Metadata;
      status?: ThreadStatus;
      values?: Record<string, unknown>;
      limit: number;
      offset: number;
      sort_by?: "thread_id" | "status" | "created_at" | "updated_at";
      sort_order?: "asc" | "desc";
    },
    auth: AuthContext | undefined
  ): AsyncGenerator<{ thread: Thread; total: number }> {
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
        .sort((a, b) => {
          const sortBy = options.sort_by ?? "created_at";
          const sortOrder = options.sort_order ?? "desc";

          if (sortBy === "created_at" || sortBy === "updated_at") {
            const aTime = a[sortBy].getTime();
            const bTime = b[sortBy].getTime();
            return sortOrder === "desc" ? bTime - aTime : aTime - bTime;
          }

          if (sortBy === "thread_id" || sortBy === "status") {
            const aVal = a[sortBy];
            const bVal = b[sortBy];
            return sortOrder === "desc"
              ? bVal.localeCompare(aVal)
              : aVal.localeCompare(bVal);
          }

          return 0;
        });

      // Calculate total count before pagination
      const total = filtered.length;

      for (const thread of filtered.slice(
        options.offset,
        options.offset + options.limit
      )) {
        yield { thread, total };
      }
    });
  }

  // TODO: make this accept `undefined`
  static async get(
    thread_id: string,
    auth: AuthContext | undefined
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
    auth: AuthContext | undefined
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
    auth: AuthContext | undefined
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
    }
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
    });
  }

  static async delete(
    thread_id: string,
    auth: AuthContext | undefined
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
    auth: AuthContext | undefined
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
      auth: AuthContext | undefined
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
      auth: AuthContext | undefined
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

      // do a check if there are no pending runs
      await conn.with(async (STORE) => {
        if (
          Object.values(STORE.runs).some(
            (run) =>
              run.thread_id === threadId &&
              (run.status === "pending" || run.status === "running")
          )
        ) {
          throw new HTTPException(409, { message: "Thread is busy" });
        }
      });

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
      auth: AuthContext | undefined
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
        }))
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
      auth: AuthContext | undefined
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
      const pendingRunIds = Object.values(STORE.runs)
        .filter((run) => run.status === "pending" && run.created_at < now)
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
        .map((run) => run.run_id);

      if (!pendingRunIds.length) {
        return;
      }

      for (const runId of pendingRunIds) {
        if (StreamManager.isLocked(runId)) continue;

        try {
          const signal = StreamManager.lock(runId);
          const run = STORE.runs[runId];

          if (!run) continue;

          const threadId = run.thread_id;
          const thread = STORE.threads[threadId];

          if (!thread) {
            logger.warn(`Unexpected missing thread in Runs.next: ${threadId}`);
            continue;
          }

          // is the run still valid?
          if (run.status !== "pending") continue;
          if (
            Object.values(STORE.runs).some(
              (run) => run.thread_id === threadId && run.status === "running"
            )
          ) {
            continue;
          }

          options.schedulePersist();
          STORE.retry_counter[runId] ??= 0;
          STORE.retry_counter[runId] += 1;
          STORE.runs[runId].status = "running";

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
    auth: AuthContext | undefined
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
        }
      );

      const metadata = mutable.metadata ?? {};
      const config: RunnableConfig = kwargs.config ?? {};

      const existingThread = Object.values(STORE.threads).find(
        (thread) => thread.thread_id === threadId
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
              config?.configurable
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
                config?.configurable
              ),
            }
          );

          existingThread.updated_at = now;
        }
      } else {
        return [];
      }

      // if multitask_mode = reject, check for inflight runs
      // and if there are any, return them to reject putting a new run
      const inflightRuns = Object.values(STORE.runs).filter(
        (run) =>
          run.thread_id === threadId &&
          (run.status === "pending" || run.status === "running")
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
          context:
            typeof assistant.context !== "object" && assistant.context != null
              ? assistant.context ?? kwargs.context
              : Object.assign({}, assistant.context, kwargs.context),
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
    auth: AuthContext | undefined
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
    auth: AuthContext | undefined
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
    auth: AuthContext | undefined
  ) {
    const runStream = Runs.Stream.join(
      runId,
      threadId,
      { ignore404: threadId == null, lastEventId: undefined },
      auth
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
    auth: AuthContext | undefined
  ) {
    // check if thread exists
    await Threads.get(threadId, auth);

    const lastChunk = await Runs.wait(runId, threadId, auth);
    if (lastChunk != null) return lastChunk;

    const thread = await Threads.get(threadId, auth);
    return thread.values ?? null;
  }

  static async cancel(
    threadId: string | undefined,
    runIds: string[],
    options: {
      action?: "interrupt" | "rollback";
    },
    auth: AuthContext | undefined
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

            const thread = STORE.threads[run.thread_id];
            if (thread) {
              thread.status = "idle";
              thread.updated_at = new Date();
            }
          } else {
            logger.info(
              "Eagerly deleting unscheduled run with rollback action",
              {
                run_id: runId,
                thread_id: threadId,
              }
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
    auth: AuthContext | undefined
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
        lastEventId: string | undefined;
      },
      auth: AuthContext | undefined
    ): AsyncGenerator<{ id?: string; event: string; data: unknown }> {
      yield* conn.withGenerator(async function* (STORE) {
        // TODO: what if we're joining an already completed run? Should we check before?
        const signal = options?.cancelOnDisconnect;
        const queue = StreamManager.getQueue(runId, {
          ifNotFound: "create",
          resumable: options.lastEventId != null,
        });

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

        let lastEventId = options?.lastEventId;
        while (!signal?.aborted) {
          try {
            const [id, message] = await queue.get({
              timeout: 500,
              signal,
              lastEventId,
            });

            lastEventId = id;

            if (message.topic === `run:${runId}:control`) {
              if (message.data === "done") break;
            } else {
              const streamTopic = message.topic.substring(
                `run:${runId}:stream:`.length
              );

              yield { id, event: streamTopic, data: message.data };
            }
          } catch (error) {
            if (error instanceof AbortError) break;

            const run = await Runs.get(runId, threadId, auth);
            if (run == null) {
              if (!options?.ignore404)
                yield { event: "error", data: "Run not found" };
              break;
            } else if (run.status !== "pending" && run.status !== "running") {
              break;
            }
          }
        }

        if (signal?.aborted && threadId != null) {
          await Runs.cancel(threadId, [runId], { action: "interrupt" }, auth);
        }
      });
    }

    static async publish(payload: {
      runId: string;
      event: string;
      data: unknown;
      resumable: boolean;
    }) {
      const queue = StreamManager.getQueue(payload.runId, {
        ifNotFound: "create",
        resumable: payload.resumable,
      });
      queue.push({
        topic: `run:${payload.runId}:stream:${payload.event}`,
        data: payload.data,
      });
    }
  };
}

export class Crons {}
