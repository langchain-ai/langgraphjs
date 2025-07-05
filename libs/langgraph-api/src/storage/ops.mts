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
import { store } from "./store.mjs";
import { StorageOps } from "./ops/index.mjs";
import { Thread } from "./types/thread.mjs";
import type { SEARCH_OPTIONS } from "./ops/ops_adapter.mjs";
import type { Metadata, OnConflictBehavior } from "./types/index.mjs";
import type { RunStatus, StreamMode, MultitaskStrategy, RunKwargs, Run } from "./types/run.mjs";
import type { RunnableConfig } from "./types/runnableConfig.mjs";
import { AbortError } from "./queue/index.mjs";
import { StreamManager } from "./stream/index.mjs";
import { ABORT_ACTION } from "./stream/types.mjs";

export type ThreadStatus = "idle" | "busy" | "interrupted" | "error";
export type IfNotExists = "create" | "reject";
export type { RunnableConfig };

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
  assistant_version_id: string;
  assistant_id: string;
  version: number;
  graph_id: string;
  config: RunnableConfig;
  metadata: Metadata;
  created_at: Date;
  name: string | undefined;
}

export type RetryCounter = {
  run_id: string;
  counter: number;
  created_at: Date;
  updated_at: Date;
}

export const truncate = async (flags: {
  runs?: boolean;
  threads?: boolean;
  assistants?: boolean;
  checkpointer?: boolean;
  store?: boolean;
  full: boolean;
}) => {
  const full = flags.full || false;

  if (flags.runs) await Runs.truncate();
  if (flags.threads) await Threads.truncate();
  if (flags.assistants) await Assistants.truncate(full);
  if (flags.checkpointer) await checkpointer.clear();
  if (flags.store) await store.clear();
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

export class AssistantVersions {
  static storage = new StorageOps<AssistantVersion>("assistant_versions", "assistant_version_id");

  static async *search(
    options: {
      where: {
        assistant_id?: string;
        version?: number;
      }
      limit?: number;
      offset?: number;
      sort_by?: "thread_id" | "status" | "created_at" | "updated_at" | "version";
      sort_order?: "asc" | "desc";
    },
    auth: AuthContext | undefined,
  ): AsyncGenerator<{ assistant_version: AssistantVersion; total: number }> {
    const searchOptions: SEARCH_OPTIONS = {
      limit: options.limit,
      offset: options.offset,
      sort_by: options.sort_by ?? 'version',
      sort_order: options.sort_order ?? 'desc',
      where: {
        assistant_id: options.where.assistant_id,
        version: options.where.version,
      },
    };
    
    for await (const { item, total } of AssistantVersions.storage.search(searchOptions)) {
      yield { assistant_version: item, total };
    }
  }

  static async put(key: string, version: AssistantVersion): Promise<AssistantVersion | null> {
    return await AssistantVersions.storage.put({key: key, model: version});
  }

  static async delete(
    options: {
      where: {
        assistant_id?: string;
        version?: number;
      }
    },
    auth: AuthContext | undefined, // For consistency, but technically this is only called internally
  ): Promise<boolean> {
    return await AssistantVersions.storage.delete(options);
  }

  static async nextVersion(assistant_id: string): Promise<number> {
    const searchOptions: SEARCH_OPTIONS = {
      where: {
        assistant_id: assistant_id
      },
      offset: 0,
      limit: 1,
      sort_by: "version",
      sort_order: "desc" as const,
    }

    let version;
    for await (const { item } of AssistantVersions.storage.search(searchOptions)) {
      version = item.version;
    }

    return version ? (version + 1) : 1;
  }
}
export class Assistants {
  static storage = new StorageOps<Assistant>("assistants", "assistant_id");

  // DONE
  static async *search(
    options: {
      graph_id?: string;
      metadata?: Metadata;
      limit: number;
      offset: number;
      sort_by?: "assistant_id" | "created_at" | "updated_at";
      sort_order?: "asc" | "desc";
    },
    auth: AuthContext | undefined,
  ): AsyncGenerator<{ assistant: Assistant; total: number }> {
    const [filters] = await handleAuthEvent(auth, "assistants:search", {
      graph_id: options.graph_id,
      metadata: options.metadata,
      limit: options.limit,
      offset: options.offset,
    });

    const searchOptions: SEARCH_OPTIONS = {
      limit: options.limit,
      offset: options.offset,
      sort_by: options.sort_by ?? 'created_at',
      sort_order: options.sort_order ?? 'desc',
      where: {
        metadata: options.metadata,
        graph_id: options.graph_id,
      },
      authFilters: filters,
    };
    
    for await (const { item, total } of Assistants.storage.search(searchOptions)) {
      yield { assistant: item, total };
    }
  }

  // DONE
  static async get(
    assistant_id: string,
    auth: AuthContext | undefined,
  ): Promise<Assistant> {
    const [filters] = await handleAuthEvent(auth, "assistants:read", {
      assistant_id,
    });

    const result = await Assistants.storage.get({ key: assistant_id });

    if (result == null)
      throw new HTTPException(404, { message: "Assistant not found" });
    if (!isAuthMatching(result["metadata"], filters)) {
      throw new HTTPException(404, { message: "Assistant not found" });
    }
    return { ...result, name: result.name ?? result.graph_id };
  }

  // DONE
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
    // Map internal OnConflictBehavior to API-compatible values
    const apiIfExists = options.if_exists === "update" ? "do_nothing" : options.if_exists;
    
    const [filters, mutable] = await handleAuthEvent(
      auth,
      "assistants:create",
      {
        assistant_id,
        config: options.config,
        graph_id: options.graph_id,
        metadata: options.metadata,
        if_exists: apiIfExists as "raise" | "do_nothing",
        name: options.name,
      },
    );

    const existingAssistant = await Assistants.storage.get({key: assistant_id});

    if (existingAssistant !== null) {
      if (!isAuthMatching(existingAssistant?.metadata, filters)) {
        throw new HTTPException(409, { message: "Assistant already exists" });
      }

      if (options.if_exists === "raise") {
        throw new HTTPException(409, { message: "Assistant already exists" });
      }

      return existingAssistant;
    }

    const now = new Date();

    const assistant = {
      assistant_id: assistant_id,
      version: 1,
      config: options.config ?? {},
      created_at: now,
      updated_at: now,
      graph_id: options.graph_id,
      metadata: mutable.metadata ?? ({} as Metadata),
      name: options.name || options.graph_id,
    };

    const versionId = uuid4();
    const version = {
      assistant_version_id: versionId,
      assistant_id: assistant_id,
      version: 1,
      graph_id: options.graph_id,
      config: options.config ?? {},
      metadata: mutable.metadata ?? ({} as Metadata),
      created_at: now,
      name: options.name || options.graph_id,
    }

    const asstResult = await Assistants.storage.put({ key: assistant_id, model: assistant })

    await AssistantVersions.storage.put({ key: versionId, model: version })

    return asstResult as Assistant;
  }

  // DONE
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

    const assistant = await Assistants.storage.get({ key: assistantId });

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

    const newVersion = await AssistantVersions.nextVersion(assistantId);

    const versionId = uuid4();
    const newVersionEntry = {
      assistant_version_id: versionId,
      assistant_id: assistantId,
      version: newVersion,
      graph_id: options?.graph_id ?? assistant["graph_id"],
      config: options?.config ?? assistant["config"],
      name: options?.name ?? assistant["name"],
      metadata: metadata ?? assistant["metadata"],
      created_at: now,
    };

    assistant.version = newVersion
    await Assistants.storage.patch({
      key: assistantId,
      model: assistant
    });
    await AssistantVersions.storage.put({ key: versionId, model: newVersionEntry })

    return assistant;
  }

  static async delete(
    assistant_id: string,
    auth: AuthContext | undefined,
  ): Promise<string[]> {
    const [filters] = await handleAuthEvent(auth, "assistants:delete", {
      assistant_id,
    });

    const assistant = await Assistants.storage.get({key: assistant_id});

    if (!assistant) {
      throw new HTTPException(404, { message: "Assistant not found" });
    }

    if (!isAuthMatching(assistant["metadata"], filters)) {
      throw new HTTPException(404, { message: "Assistant not found" });
    }

    await Assistants.storage.delete({
      where: {
        key: assistant_id
      }
    })

    await AssistantVersions.delete({
      where: {
        assistant_id: assistant_id
      },
    }, auth)

    await Runs.storage.delete({
      where: {
        assistant_id: assistant_id
      }
    })

    return [assistant.assistant_id];
  }

  // DONE
  static async setLatest(
    assistant_id: string,
    version: number,
    auth: AuthContext | undefined,
  ): Promise<Assistant> {
    const [filters] = await handleAuthEvent(auth, "assistants:update", {
      assistant_id,
      version,
    });

    const assistant = await Assistants.storage.get({key: assistant_id});

    if (!assistant) {
      throw new HTTPException(404, { message: "Assistant not found" });
    }

    if (!isAuthMatching(assistant["metadata"], filters)) {
      throw new HTTPException(404, { message: "Assistant not found" });
    }

    const assistantVersion = await AssistantVersions.storage.get({
      where: {
        assistant_id: assistant_id,
        version: version
      }
    });

    if (!assistantVersion)
      throw new HTTPException(404, {
        message: "Assistant version not found",
      });

    const now = new Date();
    const assistantUpdates = {
      ...assistant,
      config: assistantVersion["config"],
      metadata: assistantVersion["metadata"],
      version: assistantVersion["version"],
      name: assistantVersion["name"],
      updated_at: now,
    };

    return await Assistants.storage.patch({ key: assistant_id, model: assistantUpdates })
  }

  // DONE
  static async getVersions(
    assistant_id: string,
    options: {
      limit: number;
      offset: number;
      metadata?: Metadata;
    },
    auth: AuthContext | undefined,
  ): Promise<AssistantVersion[]> {
    const [filters] = await handleAuthEvent(auth, "assistants:read", {
      assistant_id,
    });

    const versions: AssistantVersion[] = [];
    
    const searchOptions: SEARCH_OPTIONS = {
      limit: options.limit,
      offset: options.offset,
      sort_by: "version",
      sort_order: "desc",
      where: {
        assistant_id: assistant_id,
        metadata: options.metadata,
      },
      authFilters: filters,
    };
    
    for await (const { item } of AssistantVersions.storage.search(searchOptions)) {
      versions.push(item);
    }

    return versions;
  }

  // DONE
  static async truncate(full: boolean = false) {
    if (full) {
      // For full truncate, just delete everything without searching for system assistants
      await Assistants.storage.truncate();
      await AssistantVersions.storage.truncate();
      return;
    }

    // For partial truncate, preserve system assistants
    const assistantsToKeep: Assistant[] = [];
    
    for await (const { assistant } of Assistants.search({
      limit: 1000, // Use a large limit to get all assistants
      offset: 0,
      metadata: { created_by: "system" }
    }, undefined)) {
      // Only keep system assistants with deterministic UUIDs based on graph_id
      if (uuid5(assistant.graph_id, NAMESPACE_GRAPH) === assistant.assistant_id) {
        assistantsToKeep.push(assistant);
      }
    }

    // Also collect assistant versions for system assistants
    const versionsToKeep: AssistantVersion[] = [];
    for (const assistant of assistantsToKeep) {
      for await (const { assistant_version } of AssistantVersions.search({
        where: {
          assistant_id: assistant.assistant_id
        },
        limit: 1000,
        offset: 0
      }, undefined)) {
        versionsToKeep.push(assistant_version);
      }
    }

    // Truncate everything
    await Assistants.storage.truncate();
    await AssistantVersions.storage.truncate();

    // Re-insert the system assistants and their versions
    for (const assistant of assistantsToKeep) {
      await Assistants.storage.put({ key: assistant.assistant_id, model: assistant });
    }
    
    for (const version of versionsToKeep) {
      await AssistantVersions.storage.put({ 
        key: version.assistant_version_id, 
        model: version 
      });
    }
  }
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
  static storage = new StorageOps<Thread>("threads", "thread_id");

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
    auth: AuthContext | undefined,
  ): AsyncGenerator<{ thread: Thread; total: number }> {
    const [filters] = await handleAuthEvent(auth, "threads:search", {
      metadata: options.metadata,
      status: options.status,
      values: options.values,
      limit: options.limit,
      offset: options.offset,
    });

    const searchOptions: SEARCH_OPTIONS = {
      limit: options.limit,
      offset: options.offset,
      sort_by: options.sort_by ?? 'created_at',
      sort_order: options.sort_order ?? 'desc',
      where: {
        metadata: options.metadata,
        values: options.values,
        status: options.status,
      },
      authFilters: filters,
    };
    
    for await (const { item, total } of Threads.storage.search(searchOptions)) {
      yield { thread: item, total };
    }
  }

  // TODO: make this accept `undefined`
  static async get(
    thread_id: string,
    auth: AuthContext | undefined,
  ): Promise<Thread> {
    const [filters] = await handleAuthEvent(auth, "threads:read", {
      thread_id,
    });

    const result = await Threads.storage.get({ key: thread_id });

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
  }

  static async put(
    thread_id: string,
    options: {
      metadata?: Metadata;
      if_exists: OnConflictBehavior;
    },
    auth: AuthContext | undefined,
  ): Promise<Thread> {
    // Map internal OnConflictBehavior to API-compatible values
    const apiIfExists = options.if_exists === "update" ? "do_nothing" : options.if_exists;
    
    const [filters, mutable] = await handleAuthEvent(auth, "threads:create", {
      thread_id,
      metadata: options.metadata,
      if_exists: apiIfExists as "raise" | "do_nothing",
    });

    const now = new Date();
    const existingThread = await Threads.storage.get({ key: thread_id });

    if (existingThread != null) {
      if (!isAuthMatching(existingThread["metadata"], filters)) {
        throw new HTTPException(409, { message: "Thread already exists" });
      }

      if (options?.if_exists === "raise") {
        throw new HTTPException(409, { message: "Thread already exists" });
      }

      return existingThread;
    }

    const result = {
      thread_id: thread_id,
      created_at: now,
      updated_at: now,
      metadata: mutable?.metadata ?? {},
      status: "idle" as ThreadStatus,
      config: {},
      values: undefined,
    }

    await Threads.storage.put({ key: thread_id, model: result });

    return result;
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

    const thread = await Threads.storage.get({ key: threadId });
    if (!thread) {
      throw new HTTPException(404, { message: "Thread not found" });
    }

    if (!isAuthMatching(thread.metadata, filters)) {
      // TODO: is this correct status code?
      throw new HTTPException(404, { message: "Thread not found" });
    }

    const now = new Date();
    if (mutable.metadata != null) {
      thread.metadata = {
        ...thread.metadata,
        ...mutable.metadata,
      };
    }
    thread.updated_at = now;

    await Threads.storage.patch({ key: threadId, model: thread });

    return thread;
  }

  static async setStatus(
    threadId: string,
    options: {
      checkpoint?: CheckpointPayload;
      exception?: Error;
    },
  ) {
    const thread = await Threads.storage.get({key: threadId});

    if (!thread)
      throw new HTTPException(404, { message: "Thread not found" });

    let hasNext = false;
    if (options.checkpoint != null) {
      hasNext = options.checkpoint.next.length > 0;
    }

    // Check for ANY pending or running runs (no temporal filtering for concurrency)
    const runs = await Runs.storage.where({
      where: {
        thread_id: threadId,
        $or: [
          { status: "pending" },
          { status: "running" }
        ]
      },
      limit: 1
    });
    
    const hasPendingRuns = runs.length > 0;

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

    return await Threads.storage.patch({ key: threadId, model: thread });
  }

  static async delete(
    thread_id: string,
    auth: AuthContext | undefined,
  ): Promise<string[]> {
    const [filters] = await handleAuthEvent(auth, "threads:delete", {
      thread_id,
    });

    const thread = await Threads.storage.get({key: thread_id});

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

    await Threads.storage.delete({ where: { thread_id: thread_id } })
    await Runs.storage.delete({ where: { thread_id: thread_id } });

    checkpointer.delete(thread_id, null);

    return [thread.thread_id];
  }

  static async truncate() {
    return Threads.storage.truncate();
  }

  static async copy(
    thread_id: string,
    auth: AuthContext | undefined,
  ): Promise<Thread> {
    const [filters] = await handleAuthEvent(auth, "threads:read", {
      thread_id,
    });

    const thread = await Threads.storage.get({ key: thread_id });

    if (!thread)
      throw new HTTPException(409, { message: "Thread not found" });

    if (!isAuthMatching(thread["metadata"], filters)) {
      throw new HTTPException(409, { message: "Thread not found" });
    }

    const newThreadId = uuid4();
    const now = new Date();
    const newThread: Thread = {
      thread_id: newThreadId,
      created_at: now,
      updated_at: now,
      metadata: { ...thread.metadata, thread_id: newThreadId },
      config: {},
      status: "idle",
    };
    await Threads.storage.put({ key: newThreadId, model: newThread });

    await checkpointer.copy(thread_id, newThreadId);

    return newThread;
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

      // Check for ANY pending or running runs (no temporal filtering for concurrency)
      const runs = await Runs.storage.where({
        where: {
          thread_id: threadId,
          $or: [
            { status: "pending" },
            { status: "running" }
          ]
        },
        limit: 1
      });

      if (runs.length > 0) {
        throw new HTTPException(409, { message: "Thread is busy" });
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

      console.log(`we are calling post to update state`)
      const nextConfig = await graph.updateState(updateConfig, values, asNode);
      const state = await Threads.State.get(config, { subgraphs: false }, auth);

      // update thread values
      const threadToUpdate = await Threads.storage.get({ key: threadId });
      if (!threadToUpdate) {
        throw new HTTPException(404, {
          message: `No thread found for "${threadId}". Make sure the thread ID is for a valid thread.`,
        });
      }
      threadToUpdate.values = state.values;
      await Threads.storage.put({ key: threadId, model: threadToUpdate });

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

      console.log(`we are calling bulk update state`)
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
      const threadToUpdate = await Threads.storage.get({ key: threadId });
      if (!threadToUpdate) {
        throw new HTTPException(404, {
          message: `No thread found for "${threadId}". Make sure the thread ID is for a valid thread.`,
        });
      }
      threadToUpdate.values = state.values;
      await Threads.storage.put({ key: threadId, model: threadToUpdate });

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
export class RetryCounters {
  static storage = new StorageOps<RetryCounter>("retry_counter", "run_id");
}
export class Runs {
  static storage = new StorageOps<Run>("runs", "run_id");

  static async *next(): AsyncGenerator<{
    run: Run;
    attempt: number;
    signal: AbortSignal;
  }> {
    const now = new Date();
    const runs = await Runs.storage.where({
      where: {
        status: "pending",
        created_at: { $le: now }  // Only get runs scheduled for now or earlier
      }
    });

    const pendingRuns = runs.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

    if (!pendingRuns.length) {
      return;
    }

    for (const run of pendingRuns) {
      const runId = run.run_id;
      const threadId = run.thread_id;
      const thread = await Threads.storage.get({ key: threadId });

      if (!thread) {
        await console.warn(
          `Unexpected missing thread in Runs.next: ${threadId}`,
        );
        continue;
      }

      if (await StreamManager.isLocked(runId)) continue;
      try {
        const signal = await StreamManager.lock(runId);
        
        // If lock failed (returns null), skip this run
        if (signal === null) continue;

        const now = new Date();
        const counter = await RetryCounters.storage.get({ key: runId }) || { run_id: runId, counter: 0, created_at: now, updated_at: now } as RetryCounter
        counter.counter += 1;

        await RetryCounters.storage.put({ key: runId, model: counter });

        yield { run, attempt: counter.counter, signal };
      } finally {
        await StreamManager.unlock(runId);
      }
    }
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

    const assistant = await Assistants.storage.get({ key: assistantId });
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

    const existingThread = await Threads.storage.get({ key: threadId });

    if (
      existingThread &&
      !isAuthMatching(existingThread["metadata"], filters)
    ) {
      throw new HTTPException(404);
    }

    const now = new Date();

    console.log(`metadata is...`)
    console.log(metadata)
    if (!existingThread && (threadId == null || ifNotExists === "create")) {
      threadId ??= uuid4();
      console.log(`the thread not exists!`)
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
      await Threads.storage.put({ key: threadId, model: thread });

    } else if (existingThread) {
      console.log(`the thread already exists!`)
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
        await Threads.storage.patch({ key: threadId, model: existingThread });
      }
    } else {
      return [];
    }

    // if multitask_mode = reject, check for inflight runs
    // and if there are any, return them to reject putting a new run
    const inflightRuns: Run[] = await Runs.storage.where({ 
      where: {
        thread_id: threadId,
        status: "pending"
      }
    })

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

    console.log(`updating run with: `, newRun.metadata)
    await Runs.storage.put({ key: runId, model: newRun });
    const run = await Runs.storage.get({ key: runId });
    console.log(`stored run metadata`)
    console.log(run?.metadata)
    return [newRun, ...inflightRuns];
  }

  static async get(
    runId: string,
    thread_id: string | undefined,
    auth: AuthContext | undefined,
  ): Promise<Run | null> {
    const [filters] = await handleAuthEvent(auth, "threads:read", {
      thread_id,
    });

    const run = await Runs.storage.get({ 
      where: {
        key: runId,
        thread_id: thread_id
      }
    });

    if (!run) return null;

    if (filters != null) {
      const thread = await Threads.storage.get({ key: run.thread_id });
      if (thread && !isAuthMatching(thread["metadata"], filters)) return null;
    }

    return run;
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

    const run = await Runs.storage.get({ 
      where: {
        key: run_id,
        thread_id: thread_id
      }
    });

    if (!run)
      throw new HTTPException(404, { message: "Run not found" });

    if (filters != null) {
      const thread = await Threads.storage.get({ key: run.thread_id });
      if (thread && !isAuthMatching(thread["metadata"], filters)) {
        throw new HTTPException(404, { message: "Run not found" });
      }
    }

    if (thread_id != null) checkpointer.delete(thread_id, run_id);
    await Runs.storage.delete({ where: { run_id: run_id } });
    return run.run_id;
  }

  static async truncate() {
    return Runs.storage.truncate();
  }

  static async wait(
    runId: string,
    threadId: string | undefined,
    auth: AuthContext | undefined,
  ) {
    const runStream = Runs.Stream.join(
      runId,
      threadId,
      { ignore404: threadId == null, lastEventId: undefined },
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
    return thread.values ?? null;
  }

  static async cancel(
    threadId: string | undefined,
    runIds: string[],
    options: {
      action?: ABORT_ACTION
    },
    auth: AuthContext | undefined,
  ) {
    const action = options.action ?? "interrupt";
    const promises: Promise<unknown>[] = [];

    const [filters] = await handleAuthEvent(auth, "threads:update", {
      thread_id: threadId,
      action,
      metadata: { run_ids: runIds, status: "pending" },
    });

    const runs = await Runs.storage.where({
      where: {
        run_id: runIds
      }
    });

    const threadIds = new Set();
    runs.forEach((run) => threadIds.add(run.thread_id));
    const threads = await Threads.storage.where({ 
      where: {
        thread_id: Array.from(threadIds)
      }
    })

    const threadsById: Record<string, Thread> = threads.reduce((acc, thread) => {
      acc[thread.thread_id] = thread;
      return acc
    }, {} as Record<string, Thread>);

    let foundRunsCount = 0;
    for (const run of runs) {
      const runId = run.run_id
      const thread = threadsById[run.thread_id];

      if (filters != null) {
        if (thread && !isAuthMatching(thread["metadata"], filters)) continue;
      }

      foundRunsCount += 1;

      // send cancellation message
      const aborted = await StreamManager.abort(runId, options.action ?? "interrupt");

      if (run.status === "pending") {
        if (aborted || action !== "rollback") {
          run.status = "interrupted";
          run.updated_at = new Date();

          await Runs.storage.patch({
            key: run.run_id,
            model: run
          });

          if (thread) {
            thread.status = "idle";
            thread.updated_at = new Date();

            await Threads.storage.patch({
              key: thread.thread_id,
              model: thread
            });
          }
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
      metadata: options.metadata ?? undefined,
      status: options.status ?? undefined,
    });

    const searchOptions: SEARCH_OPTIONS = {
      limit: options.limit ?? undefined,
      offset: options.offset ?? undefined,
      sort_by: 'created_at',
      where: {
        thread_id: threadId,
        metadata: options.metadata ?? undefined,
        status: options.status ?? undefined,
      },
      authFilters: filters,
    };
    
    return await Runs.storage.where(searchOptions);
  }

  static async setStatus(runId: string, status: RunStatus) {
    const run = await Runs.storage.get({ key: runId });
    if (!run) throw new Error(`Run ${runId} not found`);
    run.status = status;
    run.updated_at = new Date();
    return await Runs.storage.patch({ key: runId, model: run });
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
      auth: AuthContext | undefined,
    ): AsyncGenerator<{ id?: string; event: string; data: unknown }> {
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
        const thread = await Threads.storage.get({ key: threadId });

        if (thread && !isAuthMatching(thread["metadata"], filters)) {
          yield {
            event: "error",
            data: { error: "Error", message: "404: Thread not found" },
          };
          return;
        }
      }

      // Early check for run existence when ignore404 is true to avoid unnecessary waiting
      if (options?.ignore404) {
        const run = await Runs.get(runId, threadId, auth);
        if (run == null) {
          return; // Exit immediately with no events when ignore404 and run doesn't exist
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
              `run:${runId}:stream:`.length,
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
          } else if (run.status !== "pending") {
            break;
          }
        }
      }

      if (signal?.aborted && threadId != null) {
        await Runs.cancel(threadId, [runId], { action: "interrupt" }, auth);
      }
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
      await queue.push({
        topic: `run:${payload.runId}:stream:${payload.event}`,
        data: payload.data,
      });
    }
  };
}

export class Crons {}