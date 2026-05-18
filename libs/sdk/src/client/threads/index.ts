import { v7 as uuidv7 } from "uuid";

import {
  Checkpoint,
  Config,
  DefaultValues,
  Metadata,
  SortOrder,
  Thread,
  ThreadSelectField,
  ThreadSortBy,
  ThreadState,
  ThreadStatus,
  ThreadValuesFilter,
} from "../../schema.js";
import type { Command, OnConflictBehavior, StreamEvent } from "../../types.js";
import type { ThreadStreamMode } from "../../types.stream.js";
import { BaseClient } from "../base.js";
import { ThreadStream } from "../stream/index.js";
import type {
  ThreadStreamOptions,
  ThreadStreamTransportKind,
} from "../stream/types.js";
import { ProtocolSseTransportAdapter } from "../stream/transport/http.js";
import { ProtocolWebSocketTransportAdapter } from "../stream/transport/websocket.js";
import type { TransportAdapter } from "../stream/transport.js";

export class ThreadsClient<
  TStateType = DefaultValues,
  TUpdateType = TStateType,
> extends BaseClient {
  /**
   * Get a thread by ID.
   *
   * @param threadId ID of the thread.
   * @returns The thread.
   */
  async get<ValuesType = TStateType>(
    threadId: string,
    options?: { signal?: AbortSignal; include?: string[] }
  ): Promise<Thread<ValuesType>> {
    return this.fetch<Thread<ValuesType>>(`/threads/${threadId}`, {
      params: {
        include: options?.include ?? undefined,
      },
      signal: options?.signal,
    });
  }

  /**
   * Create a new thread.
   *
   * @param payload Payload for creating a thread.
   * @returns The created thread.
   */
  async create(payload?: {
    metadata?: Metadata;
    threadId?: string;
    ifExists?: OnConflictBehavior;
    graphId?: string;
    supersteps?: Array<{
      updates: Array<{ values: unknown; command?: Command; asNode: string }>;
    }>;
    ttl?: number | { ttl: number; strategy?: "delete" };
    signal?: AbortSignal;
  }): Promise<Thread<TStateType>> {
    const ttlPayload =
      typeof payload?.ttl === "number"
        ? { ttl: payload.ttl, strategy: "delete" as const }
        : payload?.ttl;

    return this.fetch<Thread<TStateType>>(`/threads`, {
      method: "POST",
      json: {
        metadata: {
          ...payload?.metadata,
          graph_id: payload?.graphId,
        },
        thread_id: payload?.threadId,
        if_exists: payload?.ifExists,
        supersteps: payload?.supersteps?.map((s) => ({
          updates: s.updates.map((u) => ({
            values: u.values,
            command: u.command,
            as_node: u.asNode,
          })),
        })),
        ttl: ttlPayload,
      },
      signal: payload?.signal,
    });
  }

  /**
   * Copy an existing thread
   * @param threadId ID of the thread to be copied
   * @returns Newly copied thread
   */
  async copy(
    threadId: string,
    options?: { signal?: AbortSignal }
  ): Promise<Thread<TStateType>> {
    return this.fetch<Thread<TStateType>>(`/threads/${threadId}/copy`, {
      method: "POST",
      signal: options?.signal,
    });
  }

  /**
   * Update a thread.
   *
   * @param threadId ID of the thread.
   * @param payload Payload for updating the thread.
   * @returns The updated thread.
   */
  async update(
    threadId: string,
    payload?: {
      metadata?: Metadata;
      ttl?: number | { ttl: number; strategy?: "delete" };
      returnMinimal?: false;
      signal?: AbortSignal;
    }
  ): Promise<Thread>;
  async update(
    threadId: string,
    payload: {
      metadata?: Metadata;
      ttl?: number | { ttl: number; strategy?: "delete" };
      returnMinimal: true;
      signal?: AbortSignal;
    }
  ): Promise<void>;
  async update(
    threadId: string,
    payload: {
      metadata?: Metadata;
      ttl?: number | { ttl: number; strategy?: "delete" };
      returnMinimal: boolean;
      signal?: AbortSignal;
    }
  ): Promise<Thread | void>;
  async update(
    threadId: string,
    payload?: {
      metadata?: Metadata;
      ttl?: number | { ttl: number; strategy?: "delete" };
      returnMinimal?: boolean;
      signal?: AbortSignal;
    }
  ): Promise<Thread | void> {
    const ttlPayload =
      typeof payload?.ttl === "number"
        ? { ttl: payload.ttl, strategy: "delete" as const }
        : payload?.ttl;

    return this.fetch<Thread | void>(`/threads/${threadId}`, {
      method: "PATCH",
      headers: payload?.returnMinimal
        ? { Prefer: "return=minimal" }
        : undefined,
      json: { metadata: payload?.metadata, ttl: ttlPayload },
      signal: payload?.signal,
    });
  }

  /**
   * Delete a thread.
   *
   * @param threadId ID of the thread.
   */
  async delete(
    threadId: string,
    options?: { signal?: AbortSignal }
  ): Promise<void> {
    return this.fetch<void>(`/threads/${threadId}`, {
      method: "DELETE",
      signal: options?.signal,
    });
  }

  /**
   * Prune threads by ID. The 'delete' strategy removes threads entirely.
   * The 'keep_latest' strategy prunes old checkpoints but keeps threads
   * and their latest state.
   *
   * @param threadIds List of thread IDs to prune.
   * @param options Additional options for pruning.
   * @param options.strategy The prune strategy. Defaults to 'delete'.
   * @param options.signal Signal to abort the request.
   * @returns An object containing `pruned_count`.
   */
  async prune(
    threadIds: string[],
    options?: {
      strategy?: "delete" | "keep_latest";
      signal?: AbortSignal;
    }
  ): Promise<{ pruned_count: number }> {
    return this.fetch<{ pruned_count: number }>("/threads/prune", {
      method: "POST",
      json: {
        thread_ids: threadIds,
        strategy: options?.strategy ?? "delete",
      },
      signal: options?.signal,
    });
  }

  /**
   * List threads
   *
   * @param query Query options
   * @returns List of threads
   */
  async search<ValuesType = TStateType>(query?: {
    metadata?: Metadata;
    ids?: string[];
    limit?: number;
    offset?: number;
    status?: ThreadStatus;
    sortBy?: ThreadSortBy;
    sortOrder?: SortOrder;
    select?: ThreadSelectField[];
    values?: ThreadValuesFilter;
    extract?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<Thread<ValuesType>[]> {
    return this.fetch<Thread<ValuesType>[]>("/threads/search", {
      method: "POST",
      json: {
        metadata: query?.metadata ?? undefined,
        ids: query?.ids ?? undefined,
        limit: query?.limit ?? 10,
        offset: query?.offset ?? 0,
        status: query?.status,
        sort_by: query?.sortBy,
        sort_order: query?.sortOrder,
        select: query?.select ?? undefined,
        values: query?.values ?? undefined,
        extract: query?.extract ?? undefined,
      },
      signal: query?.signal,
    });
  }

  /**
   * Count threads matching filters.
   *
   * @param query.metadata Thread metadata to filter on.
   * @param query.values State values to filter on.
   * @param query.status Thread status to filter on.
   * @returns Number of threads matching the criteria.
   */
  async count<ValuesType = TStateType>(query?: {
    metadata?: Metadata;
    values?: ValuesType;
    status?: ThreadStatus;
    signal?: AbortSignal;
  }): Promise<number> {
    return this.fetch<number>(`/threads/count`, {
      method: "POST",
      json: {
        metadata: query?.metadata ?? undefined,
        values: query?.values ?? undefined,
        status: query?.status ?? undefined,
      },
      signal: query?.signal,
    });
  }

  /**
   * Get state for a thread.
   *
   * @param threadId ID of the thread.
   * @returns Thread state.
   */
  async getState<ValuesType = TStateType>(
    threadId: string,
    checkpoint?: Checkpoint | string,
    options?: { subgraphs?: boolean; signal?: AbortSignal }
  ): Promise<ThreadState<ValuesType>> {
    if (checkpoint != null) {
      if (typeof checkpoint !== "string") {
        return this.fetch<ThreadState<ValuesType>>(
          `/threads/${threadId}/state/checkpoint`,
          {
            method: "POST",
            json: { checkpoint, subgraphs: options?.subgraphs },
            signal: options?.signal,
          }
        );
      }

      // deprecated
      return this.fetch<ThreadState<ValuesType>>(
        `/threads/${threadId}/state/${checkpoint}`,
        { params: { subgraphs: options?.subgraphs }, signal: options?.signal }
      );
    }

    return this.fetch<ThreadState<ValuesType>>(`/threads/${threadId}/state`, {
      params: { subgraphs: options?.subgraphs },
      signal: options?.signal,
    });
  }

  /**
   * Add state to a thread.
   *
   * @param threadId The ID of the thread.
   * @returns
   */
  async updateState<ValuesType = TUpdateType>(
    threadId: string,
    options: {
      values: ValuesType;
      checkpoint?: Checkpoint;
      checkpointId?: string;
      asNode?: string;
      signal?: AbortSignal;
    }
  ): Promise<Pick<Config, "configurable">> {
    return this.fetch<Pick<Config, "configurable">>(
      `/threads/${threadId}/state`,
      {
        method: "POST",
        json: {
          values: options.values,
          checkpoint: options.checkpoint,
          checkpoint_id: options.checkpointId,
          as_node: options?.asNode,
        },
        signal: options?.signal,
      }
    );
  }

  /**
   * Patch the metadata of a thread.
   *
   * @param threadIdOrConfig Thread ID or config to patch the state of.
   * @param metadata Metadata to patch the state with.
   */
  async patchState(
    threadIdOrConfig: string | Config,
    metadata: Metadata,
    options?: { signal?: AbortSignal }
  ): Promise<void> {
    let threadId: string;

    if (typeof threadIdOrConfig !== "string") {
      if (typeof threadIdOrConfig.configurable?.thread_id !== "string") {
        throw new Error(
          "Thread ID is required when updating state with a config."
        );
      }
      threadId = threadIdOrConfig.configurable.thread_id;
    } else {
      threadId = threadIdOrConfig;
    }

    return this.fetch<void>(`/threads/${threadId}/state`, {
      method: "PATCH",
      json: { metadata },
      signal: options?.signal,
    });
  }

  /**
   * Get all past states for a thread.
   *
   * @param threadId ID of the thread.
   * @param options Additional options.
   * @returns List of thread states.
   */
  async getHistory<ValuesType = TStateType>(
    threadId: string,
    options?: {
      limit?: number;
      before?: Config;
      checkpoint?: Partial<Omit<Checkpoint, "thread_id">>;
      metadata?: Metadata;
      signal?: AbortSignal;
    }
  ): Promise<ThreadState<ValuesType>[]> {
    return this.fetch<ThreadState<ValuesType>[]>(
      `/threads/${threadId}/history`,
      {
        method: "POST",
        json: {
          limit: options?.limit ?? 10,
          before: options?.before,
          metadata: options?.metadata,
          checkpoint: options?.checkpoint,
        },
        signal: options?.signal,
      }
    );
  }

  async *joinStream(
    threadId: string,
    options?: {
      lastEventId?: string;
      streamMode?: ThreadStreamMode | ThreadStreamMode[];
      signal?: AbortSignal;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): AsyncGenerator<{ id?: string; event: StreamEvent; data: any }> {
    yield* this.streamWithRetry({
      endpoint: `/threads/${threadId}/stream`,
      method: "GET",
      signal: options?.signal,
      headers: options?.lastEventId
        ? { "Last-Event-ID": options.lastEventId }
        : undefined,
      params: options?.streamMode
        ? { stream_mode: options.streamMode }
        : undefined,
    });
  }

  /**
   * Open a protocol stream over the thread-centric v2 protocol.
   *
   * Returns a {@link ThreadStream} with lazy getters
   * (`.messages`, `.values`, `.toolCalls`, `.subgraphs`, `.subagents`,
   * `.output`) and `thread.run.start({ input, ... })` for starting runs.
   * Mirrors the in-process `graph.streamEvents(..., { version: "v3" })` API.
   *
   * The thread is bound to `options.assistantId` for its lifetime.
   * The wire transport defaults to SSE; pass `transport: "websocket"`
   * in options (or configure `streamProtocol: "v2-websocket"` on the
   * client) to use a WebSocket instead.
   *
   * @example New thread (UUID generated client-side)
   * ```ts
   * const thread = client.threads.stream({ assistantId: "my-agent" });
   * ```
   *
   * @example Attach to an existing thread
   * ```ts
   * const thread = client.threads.stream(threadId, { assistantId: "my-agent" });
   * ```
   *
   * @example WebSocket transport
   * ```ts
   * const thread = client.threads.stream({
   *   assistantId: "my-agent",
   *   transport: "websocket",
   * });
   * ```
   */
  stream<TExtensions extends Record<string, unknown> = Record<string, unknown>>(
    options: ThreadStreamOptions
  ): ThreadStream<TExtensions>;
  stream<TExtensions extends Record<string, unknown> = Record<string, unknown>>(
    threadId: string,
    options: ThreadStreamOptions
  ): ThreadStream<TExtensions>;
  stream<TExtensions extends Record<string, unknown> = Record<string, unknown>>(
    threadIdOrOptions: string | ThreadStreamOptions,
    maybeOptions?: ThreadStreamOptions
  ): ThreadStream<TExtensions> {
    const { threadId, options } =
      typeof threadIdOrOptions === "string"
        ? {
            threadId: threadIdOrOptions,
            options: maybeOptions as ThreadStreamOptions,
          }
        : { threadId: uuidv7(), options: threadIdOrOptions };

    // `transport` accepts either a preset string (`"sse"` / `"websocket"`)
    // or a custom {@link AgentServerAdapter}. A custom adapter replaces
    // the built-in factories entirely — this is the seam that lets users
    // point `useStream` at any agent server (including the thin wrappers
    // produced by `HttpAgentServerAdapter`).
    let transport: TransportAdapter;
    if (options.transport != null && typeof options.transport !== "string") {
      transport = options.transport;
    } else {
      const transportKind: ThreadStreamTransportKind =
        options.transport ??
        (this.streamProtocol === "v2-websocket" ? "websocket" : "sse");
      transport =
        transportKind === "websocket"
          ? new ProtocolWebSocketTransportAdapter({
              apiUrl: this.apiUrl,
              threadId,
              defaultHeaders: this.defaultHeaders,
              onRequest: this.onRequest,
              webSocketFactory: options.webSocketFactory,
            })
          : new ProtocolSseTransportAdapter({
              apiUrl: this.apiUrl,
              threadId,
              defaultHeaders: this.defaultHeaders,
              onRequest: this.onRequest,
              fetch: options.fetch,
            });
    }

    return new ThreadStream<TExtensions>(transport, options);
  }
}
