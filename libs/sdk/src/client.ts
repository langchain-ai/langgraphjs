import {
  Assistant,
  AssistantGraph,
  AssistantSortBy,
  AssistantSelectField,
  AssistantVersion,
  AssistantsSearchResponse,
  CancelAction,
  Checkpoint,
  Config,
  Cron,
  CronSelectField,
  CronCreateForThreadResponse,
  CronCreateResponse,
  CronSortBy,
  DefaultValues,
  GraphSchema,
  Item,
  ListNamespaceResponse,
  Metadata,
  Run,
  RunSelectField,
  RunStatus,
  SearchItemsResponse,
  SortOrder,
  Subgraphs,
  Thread,
  ThreadSelectField,
  ThreadSortBy,
  ThreadState,
  ThreadStatus,
  ThreadValuesFilter,
} from "./schema.js";
import type {
  Command,
  CronsCreatePayload,
  CronsUpdatePayload,
  OnConflictBehavior,
  RunsCreatePayload,
  RunsStreamPayload,
  RunsWaitPayload,
  StreamEvent,
} from "./types.js";
import type {
  StreamMode,
  ThreadStreamMode,
  TypedAsyncGenerator,
} from "./types.stream.js";
import { AsyncCaller, AsyncCallerParams } from "./utils/async_caller.js";
import { getEnvironmentVariable } from "./utils/env.js";
import { mergeSignals } from "./utils/signals.js";
import { BytesLineDecoder, SSEDecoder } from "./utils/sse.js";
import { streamWithRetry, StreamRequestParams } from "./utils/stream.js";

type HeaderValue = string | undefined | null;

function* iterateHeaders(
  headers: HeadersInit | Record<string, HeaderValue>
): IterableIterator<[string, string | null]> {
  let iter: Iterable<(HeaderValue | HeaderValue | null[])[]>;
  let shouldClear = false;

  // eslint-disable-next-line no-instanceof/no-instanceof
  if (headers instanceof Headers) {
    const entries: [string, string][] = [];
    headers.forEach((value, name) => {
      entries.push([name, value]);
    });
    iter = entries;
  } else if (Array.isArray(headers)) {
    iter = headers;
  } else {
    shouldClear = true;
    iter = Object.entries(headers ?? {});
  }

  for (const item of iter) {
    const name = item[0];
    if (typeof name !== "string")
      throw new TypeError(
        `Expected header name to be a string, got ${typeof name}`
      );
    const values = Array.isArray(item[1]) ? item[1] : [item[1]];
    let didClear = false;

    for (const value of values) {
      if (value === undefined) continue;

      // New object keys should always overwrite older headers
      // Yield a null to clear the header in the headers object
      // before adding the new value
      if (shouldClear && !didClear) {
        didClear = true;
        yield [name, null];
      }
      yield [name, value];
    }
  }
}

function mergeHeaders(
  ...headerObjects: (
    | HeadersInit
    | Record<string, HeaderValue>
    | undefined
    | null
  )[]
) {
  const outputHeaders = new Headers();
  for (const headers of headerObjects) {
    if (!headers) continue;
    for (const [name, value] of iterateHeaders(headers)) {
      if (value === null) outputHeaders.delete(name);
      else outputHeaders.append(name, value);
    }
  }
  const headerEntries: [string, string][] = [];
  outputHeaders.forEach((value, name) => {
    headerEntries.push([name, value]);
  });
  return Object.fromEntries(headerEntries);
}

/**
 * Get the API key from the environment.
 * Precedence:
 *   1. explicit argument (if string)
 *   2. LANGGRAPH_API_KEY
 *   3. LANGSMITH_API_KEY
 *   4. LANGCHAIN_API_KEY
 *
 * @param apiKey - API key provided as an argument. If null, skips environment lookup. If undefined, tries environment.
 * @returns The API key if found, otherwise undefined
 */
export function getApiKey(apiKey?: string | null): string | undefined {
  // If explicitly set to null, skip auto-loading
  if (apiKey === null) {
    return undefined;
  }

  // If a string value is provided, use it
  if (apiKey) {
    return apiKey;
  }

  // If undefined, try to load from environment
  const prefixes = ["LANGGRAPH", "LANGSMITH", "LANGCHAIN"];

  for (const prefix of prefixes) {
    const envKey = getEnvironmentVariable(`${prefix}_API_KEY`);
    if (envKey) {
      // Remove surrounding quotes
      return envKey.trim().replace(/^["']|["']$/g, "");
    }
  }

  return undefined;
}

const REGEX_RUN_METADATA =
  /(\/threads\/(?<thread_id>.+))?\/runs\/(?<run_id>.+)/;

function getRunMetadataFromResponse(
  response: Response
): { run_id: string; thread_id?: string } | undefined {
  const contentLocation = response.headers.get("Content-Location");
  if (!contentLocation) return undefined;

  const match = REGEX_RUN_METADATA.exec(contentLocation);

  if (!match?.groups?.run_id) return undefined;
  return {
    run_id: match.groups.run_id,
    thread_id: match.groups.thread_id || undefined,
  };
}

export type RequestHook = (
  url: URL,
  init: RequestInit
) => Promise<RequestInit> | RequestInit;

export interface ClientConfig {
  apiUrl?: string;
  /**
   * API key for authentication.
   * - If a string is provided, that key will be used
   * - If undefined (default), the key will be auto-loaded from environment variables (LANGGRAPH_API_KEY, LANGSMITH_API_KEY, or LANGCHAIN_API_KEY)
   * - If null, no API key will be set (skips auto-loading)
   */
  apiKey?: string | null;
  callerOptions?: AsyncCallerParams;
  timeoutMs?: number;
  defaultHeaders?: Record<string, HeaderValue>;
  onRequest?: RequestHook;
}

class BaseClient {
  protected asyncCaller: AsyncCaller;

  protected timeoutMs: number | undefined;

  protected apiUrl: string;

  protected defaultHeaders: Record<string, HeaderValue>;

  protected onRequest?: RequestHook;

  constructor(config?: ClientConfig) {
    const callerOptions = {
      maxRetries: 4,
      maxConcurrency: 4,
      ...config?.callerOptions,
    };

    let defaultApiUrl = "http://localhost:8123";
    if (
      !config?.apiUrl &&
      typeof globalThis === "object" &&
      globalThis != null
    ) {
      const fetchSmb = Symbol.for("langgraph_api:fetch");
      const urlSmb = Symbol.for("langgraph_api:url");

      const global = globalThis as unknown as {
        [fetchSmb]?: typeof fetch;
        [urlSmb]?: string;
      };

      if (global[fetchSmb]) callerOptions.fetch ??= global[fetchSmb];
      if (global[urlSmb]) defaultApiUrl = global[urlSmb];
    }

    this.asyncCaller = new AsyncCaller(callerOptions);
    this.timeoutMs = config?.timeoutMs;

    // default limit being capped by Chrome
    // https://github.com/nodejs/undici/issues/1373
    // Regex to remove trailing slash, if present
    this.apiUrl = config?.apiUrl?.replace(/\/$/, "") || defaultApiUrl;
    this.defaultHeaders = config?.defaultHeaders || {};
    this.onRequest = config?.onRequest;
    const apiKey = getApiKey(config?.apiKey);
    if (apiKey) {
      this.defaultHeaders["x-api-key"] = apiKey;
    }
  }

  protected prepareFetchOptions(
    path: string,
    options?: RequestInit & {
      json?: unknown;
      params?: Record<string, unknown>;
      timeoutMs?: number | null;
      withResponse?: boolean;
    }
  ): [url: URL, init: RequestInit] {
    const mutatedOptions = {
      ...options,
      headers: mergeHeaders(this.defaultHeaders, options?.headers),
    };

    if (mutatedOptions.json) {
      mutatedOptions.body = JSON.stringify(mutatedOptions.json);
      mutatedOptions.headers = mergeHeaders(mutatedOptions.headers, {
        "content-type": "application/json",
      });
      delete mutatedOptions.json;
    }

    if (mutatedOptions.withResponse) {
      delete mutatedOptions.withResponse;
    }

    let timeoutSignal: AbortSignal | null = null;
    if (typeof options?.timeoutMs !== "undefined") {
      if (options.timeoutMs != null) {
        timeoutSignal = AbortSignal.timeout(options.timeoutMs);
      }
    } else if (this.timeoutMs != null) {
      timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    }

    mutatedOptions.signal = mergeSignals(timeoutSignal, mutatedOptions.signal);
    const targetUrl = new URL(`${this.apiUrl}${path}`);

    if (mutatedOptions.params) {
      for (const [key, value] of Object.entries(mutatedOptions.params)) {
        if (value == null) continue;

        const strValue =
          typeof value === "string" || typeof value === "number"
            ? value.toString()
            : JSON.stringify(value);

        targetUrl.searchParams.append(key, strValue);
      }
      delete mutatedOptions.params;
    }

    return [targetUrl, mutatedOptions];
  }

  protected async fetch<T>(
    path: string,
    options: RequestInit & {
      json?: unknown;
      params?: Record<string, unknown>;
      timeoutMs?: number | null;
      signal: AbortSignal | undefined;
      withResponse: true;
    }
  ): Promise<[T, Response]>;

  protected async fetch<T>(
    path: string,
    options?: RequestInit & {
      json?: unknown;
      params?: Record<string, unknown>;
      timeoutMs?: number | null;
      signal: AbortSignal | undefined;
      withResponse?: false;
    }
  ): Promise<T>;

  protected async fetch<T>(
    path: string,
    options?: RequestInit & {
      json?: unknown;
      params?: Record<string, unknown>;
      timeoutMs?: number | null;
      signal: AbortSignal | undefined;
      withResponse?: boolean;
    }
  ): Promise<T | [T, Response]> {
    const [url, init] = this.prepareFetchOptions(path, options);

    let finalInit = init;
    if (this.onRequest) {
      finalInit = await this.onRequest(url, init);
    }

    const response = await this.asyncCaller.fetch(url.toString(), finalInit);

    const body = (() => {
      if (response.status === 202 || response.status === 204) {
        return undefined as T;
      }
      return response.json() as Promise<T>;
    })();

    if (options?.withResponse) {
      return [await body, response];
    }

    return body;
  }

  /**
   * Protected helper for streaming with automatic retry logic.
   * Handles both initial requests and reconnections with SSE.
   */
  protected async *streamWithRetry<
    T extends { id?: string; event: string; data: unknown }
  >(config: {
    endpoint: string;
    method?: string;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    params?: Record<string, unknown>;
    json?: unknown;
    maxRetries?: number;
    onReconnect?: (options: {
      attempt: number;
      lastEventId?: string;
      cause: unknown;
    }) => void;
    onInitialResponse?: (response: Response) => void | Promise<void>;
  }): AsyncGenerator<T> {
    const makeRequest = async (reconnectParams?: StreamRequestParams) => {
      // Determine endpoint - use reconnectPath if provided, otherwise original endpoint
      const requestEndpoint = reconnectParams?.reconnectPath || config.endpoint;

      // Determine method and options based on whether this is a reconnection
      const isReconnect = !!reconnectParams?.reconnectPath;
      const method = isReconnect ? "GET" : config.method || "GET";

      // Build headers - add Last-Event-ID for reconnections
      const requestHeaders =
        isReconnect && reconnectParams?.lastEventId
          ? { ...config.headers, "Last-Event-ID": reconnectParams.lastEventId }
          : config.headers;

      // Prepare fetch options
      let [url, init] = this.prepareFetchOptions(requestEndpoint, {
        method,
        timeoutMs: null,
        signal: config.signal,
        headers: requestHeaders,
        params: config.params,
        json: isReconnect ? undefined : config.json, // Only send body on initial request
      });

      // Apply onRequest hook if present
      if (this.onRequest != null) {
        init = await this.onRequest(url, init);
      }

      // Make the request
      const response = await this.asyncCaller.fetch(url.toString(), init);

      // Call onInitialResponse callback for the first request
      if (!isReconnect && config.onInitialResponse) {
        await config.onInitialResponse(response);
      }

      // Process the response body through SSE decoders
      const stream: ReadableStream<T> = (
        response.body || new ReadableStream({ start: (ctrl) => ctrl.close() })
      )
        .pipeThrough(BytesLineDecoder())
        .pipeThrough(SSEDecoder()) as ReadableStream<T>;

      return { response, stream };
    };

    // Use the utility function with our request maker
    yield* streamWithRetry(makeRequest, {
      maxRetries: config.maxRetries ?? 5,
      signal: config.signal,
      onReconnect: config.onReconnect,
    });
  }
}

export class CronsClient extends BaseClient {
  /**
   *
   * @param threadId The ID of the thread.
   * @param assistantId Assistant ID to use for this cron job.
   * @param payload Payload for creating a cron job.
   * @returns The created background run.
   */
  async createForThread(
    threadId: string,
    assistantId: string,
    payload?: CronsCreatePayload
  ): Promise<CronCreateForThreadResponse> {
    const json: Record<string, unknown> = {
      schedule: payload?.schedule,
      input: payload?.input,
      config: payload?.config,
      context: payload?.context,
      metadata: payload?.metadata,
      assistant_id: assistantId,
      interrupt_before: payload?.interruptBefore,
      interrupt_after: payload?.interruptAfter,
      webhook: payload?.webhook,
      multitask_strategy: payload?.multitaskStrategy,
      if_not_exists: payload?.ifNotExists,
      checkpoint_during: payload?.checkpointDuring,
      durability: payload?.durability,
      enabled: payload?.enabled,
    };
    return this.fetch<CronCreateForThreadResponse>(
      `/threads/${threadId}/runs/crons`,
      {
        method: "POST",
        json,
        signal: payload?.signal,
      }
    );
  }

  /**
   *
   * @param assistantId Assistant ID to use for this cron job.
   * @param payload Payload for creating a cron job.
   * @returns
   */
  async create(
    assistantId: string,
    payload?: CronsCreatePayload
  ): Promise<CronCreateResponse> {
    const json: Record<string, unknown> = {
      schedule: payload?.schedule,
      input: payload?.input,
      config: payload?.config,
      context: payload?.context,
      metadata: payload?.metadata,
      assistant_id: assistantId,
      interrupt_before: payload?.interruptBefore,
      interrupt_after: payload?.interruptAfter,
      webhook: payload?.webhook,
      on_run_completed: payload?.onRunCompleted,
      multitask_strategy: payload?.multitaskStrategy,
      if_not_exists: payload?.ifNotExists,
      checkpoint_during: payload?.checkpointDuring,
      durability: payload?.durability,
      enabled: payload?.enabled,
    };
    return this.fetch<CronCreateResponse>(`/runs/crons`, {
      method: "POST",
      json,
      signal: payload?.signal,
    });
  }

  /**
   * Update a cron job by ID.
   *
   * @param cronId The cron ID to update.
   * @param payload Payload for updating a cron job.
   * @returns The updated cron job.
   * ```
   */
  async update(cronId: string, payload?: CronsUpdatePayload): Promise<Cron> {
    const json: Record<string, unknown> = {};

    if (payload?.schedule !== undefined) {
      json.schedule = payload.schedule;
    }
    if (payload?.endTime !== undefined) {
      json.end_time = payload.endTime;
    }
    if (payload?.input !== undefined) {
      json.input = payload.input;
    }
    if (payload?.metadata !== undefined) {
      json.metadata = payload.metadata;
    }
    if (payload?.config !== undefined) {
      json.config = payload.config;
    }
    if (payload?.context !== undefined) {
      json.context = payload.context;
    }
    if (payload?.webhook !== undefined) {
      json.webhook = payload.webhook;
    }
    if (payload?.interruptBefore !== undefined) {
      json.interrupt_before = payload.interruptBefore;
    }
    if (payload?.interruptAfter !== undefined) {
      json.interrupt_after = payload.interruptAfter;
    }
    if (payload?.onRunCompleted !== undefined) {
      json.on_run_completed = payload.onRunCompleted;
    }
    if (payload?.enabled !== undefined) {
      json.enabled = payload.enabled;
    }

    return this.fetch<Cron>(`/runs/crons/${cronId}`, {
      method: "PATCH",
      json,
      signal: payload?.signal,
    });
  }

  /**
   * Delete a cron job by ID.
   *
   * @param cronId Cron ID of Cron job to delete.
   * @param options Optional parameters for the request.
   */
  async delete(
    cronId: string,
    options?: { signal?: AbortSignal }
  ): Promise<void> {
    await this.fetch<void>(`/runs/crons/${cronId}`, {
      method: "DELETE",
      signal: options?.signal,
    });
  }

  /**
   *
   * @param query Query options.
   * @returns List of crons.
   */
  async search(query?: {
    assistantId?: string;
    threadId?: string;
    enabled?: boolean;
    limit?: number;
    offset?: number;
    sortBy?: CronSortBy;
    sortOrder?: SortOrder;
    select?: CronSelectField[];
    signal?: AbortSignal;
  }): Promise<Cron[]> {
    return this.fetch<Cron[]>("/runs/crons/search", {
      method: "POST",
      json: {
        assistant_id: query?.assistantId ?? undefined,
        thread_id: query?.threadId ?? undefined,
        enabled: query?.enabled ?? undefined,
        limit: query?.limit ?? 10,
        offset: query?.offset ?? 0,
        sort_by: query?.sortBy ?? undefined,
        sort_order: query?.sortOrder ?? undefined,
        select: query?.select ?? undefined,
      },
      signal: query?.signal,
    });
  }

  /**
   * Count cron jobs matching filters.
   *
   * @param query.assistantId Assistant ID to filter by.
   * @param query.threadId Thread ID to filter by.
   * @returns Number of cron jobs matching the criteria.
   */
  async count(query?: {
    assistantId?: string;
    threadId?: string;
    signal?: AbortSignal;
  }): Promise<number> {
    return this.fetch<number>(`/runs/crons/count`, {
      method: "POST",
      json: {
        assistant_id: query?.assistantId ?? undefined,
        thread_id: query?.threadId ?? undefined,
      },
      signal: query?.signal,
    });
  }
}

export class AssistantsClient extends BaseClient {
  /**
   * Get an assistant by ID.
   *
   * @param assistantId The ID of the assistant.
   * @returns Assistant
   */
  async get(
    assistantId: string,
    options?: { signal?: AbortSignal }
  ): Promise<Assistant> {
    return this.fetch<Assistant>(`/assistants/${assistantId}`, {
      signal: options?.signal,
    });
  }

  /**
   * Get the JSON representation of the graph assigned to a runnable
   * @param assistantId The ID of the assistant.
   * @param options.xray Whether to include subgraphs in the serialized graph representation. If an integer value is provided, only subgraphs with a depth less than or equal to the value will be included.
   * @returns Serialized graph
   */
  async getGraph(
    assistantId: string,
    options?: { xray?: boolean | number; signal?: AbortSignal }
  ): Promise<AssistantGraph> {
    return this.fetch<AssistantGraph>(`/assistants/${assistantId}/graph`, {
      params: { xray: options?.xray },
      signal: options?.signal,
    });
  }

  /**
   * Get the state and config schema of the graph assigned to a runnable
   * @param assistantId The ID of the assistant.
   * @returns Graph schema
   */
  async getSchemas(
    assistantId: string,
    options?: { signal?: AbortSignal }
  ): Promise<GraphSchema> {
    return this.fetch<GraphSchema>(`/assistants/${assistantId}/schemas`, {
      signal: options?.signal,
    });
  }

  /**
   * Get the schemas of an assistant by ID.
   *
   * @param assistantId The ID of the assistant to get the schema of.
   * @param options Additional options for getting subgraphs, such as namespace or recursion extraction.
   * @returns The subgraphs of the assistant.
   */
  async getSubgraphs(
    assistantId: string,
    options?: {
      namespace?: string;
      recurse?: boolean;
      signal?: AbortSignal;
    }
  ): Promise<Subgraphs> {
    if (options?.namespace) {
      return this.fetch<Subgraphs>(
        `/assistants/${assistantId}/subgraphs/${options.namespace}`,
        { params: { recurse: options?.recurse }, signal: options?.signal }
      );
    }
    return this.fetch<Subgraphs>(`/assistants/${assistantId}/subgraphs`, {
      params: { recurse: options?.recurse },
      signal: options?.signal,
    });
  }

  /**
   * Create a new assistant.
   * @param payload Payload for creating an assistant.
   * @returns The created assistant.
   */
  async create(payload: {
    graphId: string;
    config?: Config;
    context?: unknown;
    metadata?: Metadata;
    assistantId?: string;
    ifExists?: OnConflictBehavior;
    name?: string;
    description?: string;
    signal?: AbortSignal;
  }): Promise<Assistant> {
    return this.fetch<Assistant>("/assistants", {
      method: "POST",
      json: {
        graph_id: payload.graphId,
        config: payload.config,
        context: payload.context,
        metadata: payload.metadata,
        assistant_id: payload.assistantId,
        if_exists: payload.ifExists,
        name: payload.name,
        description: payload.description,
      },
      signal: payload.signal,
    });
  }

  /**
   * Update an assistant.
   * @param assistantId ID of the assistant.
   * @param payload Payload for updating the assistant.
   * @returns The updated assistant.
   */
  async update(
    assistantId: string,
    payload: {
      graphId?: string;
      config?: Config;
      context?: unknown;
      metadata?: Metadata;
      name?: string;
      description?: string;
      signal?: AbortSignal;
    }
  ): Promise<Assistant> {
    return this.fetch<Assistant>(`/assistants/${assistantId}`, {
      method: "PATCH",
      json: {
        graph_id: payload.graphId,
        config: payload.config,
        context: payload.context,
        metadata: payload.metadata,
        name: payload.name,
        description: payload.description,
      },
      signal: payload.signal,
    });
  }

  /**
   * Delete an assistant.
   *
   * @param assistantId ID of the assistant.
   * @param deleteThreads If true, delete all threads with `metadata.assistant_id` equal to `assistantId`. Defaults to false.
   */
  async delete(
    assistantId: string,
    options?: { signal?: AbortSignal; deleteThreads?: boolean }
  ): Promise<void> {
    return this.fetch<void>(
      `/assistants/${assistantId}?delete_threads=${
        options?.deleteThreads ?? false
      }`,
      {
        method: "DELETE",
        signal: options?.signal,
      }
    );
  }

  /**
   * List assistants.
   * @param query Query options.
   * @returns List of assistants or, when includePagination is true, a mapping with the assistants and next cursor.
   */
  async search(query: {
    graphId?: string;
    name?: string;
    metadata?: Metadata;
    limit?: number;
    offset?: number;
    sortBy?: AssistantSortBy;
    sortOrder?: SortOrder;
    select?: AssistantSelectField[];
    includePagination: true;
    signal?: AbortSignal;
  }): Promise<AssistantsSearchResponse>;

  async search(query?: {
    graphId?: string;
    name?: string;
    metadata?: Metadata;
    limit?: number;
    offset?: number;
    sortBy?: AssistantSortBy;
    sortOrder?: SortOrder;
    select?: AssistantSelectField[];
    includePagination?: false;
    signal?: AbortSignal;
  }): Promise<Assistant[]>;

  async search(query?: {
    graphId?: string;
    name?: string;
    metadata?: Metadata;
    limit?: number;
    offset?: number;
    sortBy?: AssistantSortBy;
    sortOrder?: SortOrder;
    select?: AssistantSelectField[];
    includePagination?: boolean;
    signal?: AbortSignal;
  }): Promise<Assistant[] | AssistantsSearchResponse> {
    const json = {
      graph_id: query?.graphId ?? undefined,
      name: query?.name ?? undefined,
      metadata: query?.metadata ?? undefined,
      limit: query?.limit ?? 10,
      offset: query?.offset ?? 0,
      sort_by: query?.sortBy ?? undefined,
      sort_order: query?.sortOrder ?? undefined,
      select: query?.select ?? undefined,
    };
    const [assistants, response] = await this.fetch<Assistant[]>(
      "/assistants/search",
      {
        method: "POST",
        json,
        withResponse: true,
        signal: query?.signal,
      }
    );

    if (query?.includePagination) {
      const next = response.headers.get("X-Pagination-Next");
      return { assistants, next };
    }

    return assistants;
  }

  /**
   * Count assistants matching filters.
   *
   * @param query.metadata Metadata to filter by. Exact match for each key/value.
   * @param query.graphId Optional graph id to filter by.
   * @param query.name Optional name to filter by.
   * @returns Number of assistants matching the criteria.
   */
  async count(query?: {
    metadata?: Metadata;
    graphId?: string;
    name?: string;
    signal?: AbortSignal;
  }): Promise<number> {
    return this.fetch<number>(`/assistants/count`, {
      method: "POST",
      json: {
        metadata: query?.metadata ?? undefined,
        graph_id: query?.graphId ?? undefined,
        name: query?.name ?? undefined,
      },
      signal: query?.signal,
    });
  }

  /**
   * List all versions of an assistant.
   *
   * @param assistantId ID of the assistant.
   * @returns List of assistant versions.
   */
  async getVersions(
    assistantId: string,
    payload?: {
      metadata?: Metadata;
      limit?: number;
      offset?: number;
      signal?: AbortSignal;
    }
  ): Promise<AssistantVersion[]> {
    return this.fetch<AssistantVersion[]>(
      `/assistants/${assistantId}/versions`,
      {
        method: "POST",
        json: {
          metadata: payload?.metadata ?? undefined,
          limit: payload?.limit ?? 10,
          offset: payload?.offset ?? 0,
        },
        signal: payload?.signal,
      }
    );
  }

  /**
   * Change the version of an assistant.
   *
   * @param assistantId ID of the assistant.
   * @param version The version to change to.
   * @returns The updated assistant.
   */
  async setLatest(
    assistantId: string,
    version: number,
    options?: { signal?: AbortSignal }
  ): Promise<Assistant> {
    return this.fetch<Assistant>(`/assistants/${assistantId}/latest`, {
      method: "POST",
      json: { version },
      signal: options?.signal,
    });
  }
}

export class ThreadsClient<
  TStateType = DefaultValues,
  TUpdateType = TStateType
> extends BaseClient {
  /**
   * Get a thread by ID.
   *
   * @param threadId ID of the thread.
   * @returns The thread.
   */
  async get<ValuesType = TStateType>(
    threadId: string,
    options?: { signal?: AbortSignal }
  ): Promise<Thread<ValuesType>> {
    return this.fetch<Thread<ValuesType>>(`/threads/${threadId}`, {
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
    /**
     * Metadata for the thread.
     */
    metadata?: Metadata;
    /**
     * ID of the thread to create.
     *
     * If not provided, a random UUID will be generated.
     */
    threadId?: string;
    /**
     * How to handle duplicate creation.
     *
     * @default "raise"
     */
    ifExists?: OnConflictBehavior;
    /**
     * Graph ID to associate with the thread.
     */
    graphId?: string;
    /**
     * Apply a list of supersteps when creating a thread, each containing a sequence of updates.
     *
     * Used for copying a thread between deployments.
     */
    supersteps?: Array<{
      updates: Array<{ values: unknown; command?: Command; asNode: string }>;
    }>;
    /**
     * Optional time-to-live in minutes for the thread.
     * If a number is provided, it is treated as minutes and defaults to strategy "delete".
     * You may also provide an object { ttl: number, strategy?: "delete" }.
     */
    ttl?: number | { ttl: number; strategy?: "delete" };

    /**
     * Signal to abort the request.
     */
    signal?: AbortSignal;
  }): Promise<Thread<TStateType>> {
    // Normalize ttl to an object if a number is provided
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
      /**
       * Metadata for the thread.
       */
      metadata?: Metadata;
      /**
       * Optional time-to-live in minutes for the thread.
       * If a number is provided, it is treated as minutes and defaults to strategy "delete".
       * You may also provide an object { ttl: number, strategy?: "delete" }.
       */
      ttl?: number | { ttl: number; strategy?: "delete" };
      /**
       * Signal to abort the request.
       */
      signal?: AbortSignal;
    }
  ): Promise<Thread> {
    const ttlPayload =
      typeof payload?.ttl === "number"
        ? { ttl: payload.ttl, strategy: "delete" as const }
        : payload?.ttl;

    return this.fetch<Thread>(`/threads/${threadId}`, {
      method: "PATCH",
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
   * List threads
   *
   * @param query Query options
   * @returns List of threads
   */
  async search<ValuesType = TStateType>(query?: {
    /**
     * Metadata to filter threads by.
     */
    metadata?: Metadata;
    /**
     * Filter by specific thread IDs.
     */
    ids?: string[];
    /**
     * Maximum number of threads to return.
     * Defaults to 10
     */
    limit?: number;
    /**
     * Offset to start from.
     */
    offset?: number;
    /**
     * Thread status to filter on.
     */
    status?: ThreadStatus;
    /**
     * Sort by.
     */
    sortBy?: ThreadSortBy;
    /**
     * Sort order.
     * Must be one of 'asc' or 'desc'.
     */
    sortOrder?: SortOrder;
    /**
     * Array of fields to select.
     * Elements or array must be one of 'thread_id, 'created_at', 'updated_at', 'metadata', 'config', 'context', 'status', 'values', or 'interrupts'.
     */
    select?: ThreadSelectField[];
    /**
     * Values to filter threads by.
     */
    values?: ThreadValuesFilter;

    /**
     * Signal to abort the request.
     */
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
          checkpoint_id: options.checkpointId,
          checkpoint: options.checkpoint,
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
}

export class RunsClient<
  TStateType = DefaultValues,
  TUpdateType = TStateType,
  TCustomEventType = unknown
> extends BaseClient {
  stream<
    TStreamMode extends StreamMode | StreamMode[] = StreamMode,
    TSubgraphs extends boolean = false
  >(
    threadId: null,
    assistantId: string,
    payload?: Omit<
      RunsStreamPayload<TStreamMode, TSubgraphs>,
      "multitaskStrategy" | "onCompletion"
    >
  ): TypedAsyncGenerator<
    TStreamMode,
    TSubgraphs,
    TStateType,
    TUpdateType,
    TCustomEventType
  >;

  stream<
    TStreamMode extends StreamMode | StreamMode[] = StreamMode,
    TSubgraphs extends boolean = false
  >(
    threadId: string,
    assistantId: string,
    payload?: RunsStreamPayload<TStreamMode, TSubgraphs>
  ): TypedAsyncGenerator<
    TStreamMode,
    TSubgraphs,
    TStateType,
    TUpdateType,
    TCustomEventType
  >;

  /**
   * Create a run and stream the results.
   *
   * @param threadId The ID of the thread.
   * @param assistantId Assistant ID to use for this run.
   * @param payload Payload for creating a run.
   */
  async *stream<
    TStreamMode extends StreamMode | StreamMode[] = StreamMode,
    TSubgraphs extends boolean = false
  >(
    threadId: string | null,
    assistantId: string,
    payload?: RunsStreamPayload<TStreamMode, TSubgraphs>
  ): TypedAsyncGenerator<
    TStreamMode,
    TSubgraphs,
    TStateType,
    TUpdateType,
    TCustomEventType
  > {
    const json: Record<string, unknown> = {
      input: payload?.input,
      command: payload?.command,
      config: payload?.config,
      context: payload?.context,
      metadata: payload?.metadata,
      stream_mode: payload?.streamMode,
      stream_subgraphs: payload?.streamSubgraphs,
      stream_resumable: payload?.streamResumable,
      feedback_keys: payload?.feedbackKeys,
      assistant_id: assistantId,
      interrupt_before: payload?.interruptBefore,
      interrupt_after: payload?.interruptAfter,
      checkpoint: payload?.checkpoint,
      checkpoint_id: payload?.checkpointId,
      webhook: payload?.webhook,
      multitask_strategy: payload?.multitaskStrategy,
      on_completion: payload?.onCompletion,
      on_disconnect: payload?.onDisconnect,
      after_seconds: payload?.afterSeconds,
      if_not_exists: payload?.ifNotExists,
      checkpoint_during: payload?.checkpointDuring,
      durability: payload?.durability,
    };

    yield* this.streamWithRetry({
      endpoint:
        threadId == null ? `/runs/stream` : `/threads/${threadId}/runs/stream`,
      method: "POST",
      json,
      signal: payload?.signal,
      onInitialResponse: (response) => {
        const runMetadata = getRunMetadataFromResponse(response);
        if (runMetadata) payload?.onRunCreated?.(runMetadata);
      },
    }) as TypedAsyncGenerator<
      TStreamMode,
      TSubgraphs,
      TStateType,
      TUpdateType,
      TCustomEventType
    >;
  }

  /**
   * Create a run.
   *
   * @param threadId The ID of the thread.
   * @param assistantId Assistant ID to use for this run.
   * @param payload Payload for creating a run.
   * @returns The created run.
   */
  async create(
    threadId: string | null,
    assistantId: string,
    payload?: RunsCreatePayload
  ): Promise<Run> {
    const json: Record<string, unknown> = {
      input: payload?.input,
      command: payload?.command,
      config: payload?.config,
      context: payload?.context,
      metadata: payload?.metadata,
      stream_mode: payload?.streamMode,
      stream_subgraphs: payload?.streamSubgraphs,
      stream_resumable: payload?.streamResumable,
      assistant_id: assistantId,
      interrupt_before: payload?.interruptBefore,
      interrupt_after: payload?.interruptAfter,
      webhook: payload?.webhook,
      checkpoint: payload?.checkpoint,
      checkpoint_id: payload?.checkpointId,
      multitask_strategy: payload?.multitaskStrategy,
      after_seconds: payload?.afterSeconds,
      if_not_exists: payload?.ifNotExists,
      checkpoint_during: payload?.checkpointDuring,
      durability: payload?.durability,
      langsmith_tracer: payload?._langsmithTracer
        ? {
            project_name: payload?._langsmithTracer?.projectName,
            example_id: payload?._langsmithTracer?.exampleId,
          }
        : undefined,
    };

    const endpoint = threadId === null ? "/runs" : `/threads/${threadId}/runs`;
    const [run, response] = await this.fetch<Run>(endpoint, {
      method: "POST",
      json,
      signal: payload?.signal,
      withResponse: true,
    });

    const runMetadata = getRunMetadataFromResponse(response);
    if (runMetadata) payload?.onRunCreated?.(runMetadata);

    return run;
  }

  /**
   * Create a batch of stateless background runs.
   *
   * @param payloads An array of payloads for creating runs.
   * @returns An array of created runs.
   */
  async createBatch(
    payloads: (Omit<RunsCreatePayload, "signal"> & { assistantId: string })[],
    options?: { signal?: AbortSignal }
  ): Promise<Run[]> {
    const filteredPayloads = payloads
      .map((payload) => ({ ...payload, assistant_id: payload.assistantId }))
      .map((payload) => {
        return Object.fromEntries(
          Object.entries(payload).filter(([_, v]) => v !== undefined)
        );
      });

    return this.fetch<Run[]>("/runs/batch", {
      method: "POST",
      json: filteredPayloads,
      signal: options?.signal,
    });
  }

  async wait(
    threadId: null,
    assistantId: string,
    payload?: Omit<RunsWaitPayload, "multitaskStrategy" | "onCompletion">
  ): Promise<ThreadState["values"]>;

  async wait(
    threadId: string,
    assistantId: string,
    payload?: RunsWaitPayload
  ): Promise<ThreadState["values"]>;

  /**
   * Create a run and wait for it to complete.
   *
   * @param threadId The ID of the thread.
   * @param assistantId Assistant ID to use for this run.
   * @param payload Payload for creating a run.
   * @returns The last values chunk of the thread.
   */
  async wait(
    threadId: string | null,
    assistantId: string,
    payload?: RunsWaitPayload
  ): Promise<ThreadState["values"]> {
    const json: Record<string, unknown> = {
      input: payload?.input,
      command: payload?.command,
      config: payload?.config,
      context: payload?.context,
      metadata: payload?.metadata,
      assistant_id: assistantId,
      interrupt_before: payload?.interruptBefore,
      interrupt_after: payload?.interruptAfter,
      checkpoint: payload?.checkpoint,
      checkpoint_id: payload?.checkpointId,
      webhook: payload?.webhook,
      multitask_strategy: payload?.multitaskStrategy,
      on_completion: payload?.onCompletion,
      on_disconnect: payload?.onDisconnect,
      after_seconds: payload?.afterSeconds,
      if_not_exists: payload?.ifNotExists,
      checkpoint_during: payload?.checkpointDuring,
      durability: payload?.durability,
      langsmith_tracer: payload?._langsmithTracer
        ? {
            project_name: payload?._langsmithTracer?.projectName,
            example_id: payload?._langsmithTracer?.exampleId,
          }
        : undefined,
    };
    const endpoint =
      threadId == null ? `/runs/wait` : `/threads/${threadId}/runs/wait`;
    const [run, response] = await this.fetch<ThreadState["values"]>(endpoint, {
      method: "POST",
      json,
      timeoutMs: null,
      signal: payload?.signal,
      withResponse: true,
    });

    const runMetadata = getRunMetadataFromResponse(response);
    if (runMetadata) payload?.onRunCreated?.(runMetadata);

    const raiseError =
      payload?.raiseError !== undefined ? payload.raiseError : true;
    if (
      raiseError &&
      "__error__" in run &&
      typeof run.__error__ === "object" &&
      run.__error__ &&
      "error" in run.__error__ &&
      "message" in run.__error__
    ) {
      throw new Error(`${run.__error__?.error}: ${run.__error__?.message}`);
    }
    return run;
  }

  /**
   * List all runs for a thread.
   *
   * @param threadId The ID of the thread.
   * @param options Filtering and pagination options.
   * @returns List of runs.
   */
  async list(
    threadId: string,
    options?: {
      /**
       * Maximum number of runs to return.
       * Defaults to 10
       */
      limit?: number;

      /**
       * Offset to start from.
       * Defaults to 0.
       */
      offset?: number;

      /**
       * Status of the run to filter by.
       */
      status?: RunStatus;
      select?: RunSelectField[];

      /**
       * Signal to abort the request.
       */
      signal?: AbortSignal;
    }
  ): Promise<Run[]> {
    return this.fetch<Run[]>(`/threads/${threadId}/runs`, {
      params: {
        limit: options?.limit ?? 10,
        offset: options?.offset ?? 0,
        status: options?.status ?? undefined,
        select: options?.select ?? undefined,
      },
      signal: options?.signal,
    });
  }

  /**
   * Get a run by ID.
   *
   * @param threadId The ID of the thread.
   * @param runId The ID of the run.
   * @returns The run.
   */
  async get(
    threadId: string,
    runId: string,
    options?: { signal?: AbortSignal }
  ): Promise<Run> {
    return this.fetch<Run>(`/threads/${threadId}/runs/${runId}`, {
      signal: options?.signal,
    });
  }

  /**
   * Cancel a run.
   *
   * @param threadId The ID of the thread.
   * @param runId The ID of the run.
   * @param wait Whether to block when canceling
   * @param action Action to take when cancelling the run. Possible values are `interrupt` or `rollback`. Default is `interrupt`.
   * @returns
   */
  async cancel(
    threadId: string,
    runId: string,
    wait: boolean = false,
    action: CancelAction = "interrupt",
    options: { signal?: AbortSignal } = {}
  ): Promise<void> {
    return this.fetch<void>(`/threads/${threadId}/runs/${runId}/cancel`, {
      method: "POST",
      params: { wait: wait ? "1" : "0", action },
      signal: options?.signal,
    });
  }

  /**
   * Block until a run is done.
   *
   * @param threadId The ID of the thread.
   * @param runId The ID of the run.
   * @returns
   */
  async join(
    threadId: string,
    runId: string,
    options?: { signal?: AbortSignal }
  ): Promise<TStateType> {
    return this.fetch<TStateType>(`/threads/${threadId}/runs/${runId}/join`, {
      timeoutMs: null,
      signal: options?.signal,
    });
  }

  /**
   * Stream output from a run in real-time, until the run is done.
   *
   * @param threadId The ID of the thread. Can be set to `null` | `undefined` for stateless runs.
   * @param runId The ID of the run.
   * @param options Additional options for controlling the stream behavior:
   *   - signal: An AbortSignal that can be used to cancel the stream request
   *   - lastEventId: The ID of the last event received. Can be used to reconnect to a stream without losing events.
   *   - cancelOnDisconnect: When true, automatically cancels the run if the client disconnects from the stream
   *   - streamMode: Controls what types of events to receive from the stream (can be a single mode or array of modes)
   *        Must be a subset of the stream modes passed when creating the run. Background runs default to having the union of all
   *        stream modes enabled.
   * @returns An async generator yielding stream parts.
   */
  async *joinStream(
    threadId: string | undefined | null,
    runId: string,
    options?:
      | {
          signal?: AbortSignal;
          cancelOnDisconnect?: boolean;
          lastEventId?: string;
          streamMode?: StreamMode | StreamMode[];
        }
      | AbortSignal
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): AsyncGenerator<{ id?: string; event: StreamEvent; data: any }> {
    const opts =
      typeof options === "object" &&
      options != null &&
      // eslint-disable-next-line no-instanceof/no-instanceof
      options instanceof AbortSignal
        ? { signal: options }
        : options;

    yield* this.streamWithRetry({
      endpoint:
        threadId != null
          ? `/threads/${threadId}/runs/${runId}/stream`
          : `/runs/${runId}/stream`,
      method: "GET",
      signal: opts?.signal,
      headers: opts?.lastEventId
        ? { "Last-Event-ID": opts.lastEventId }
        : undefined,
      params: {
        cancel_on_disconnect: opts?.cancelOnDisconnect ? "1" : "0",
        stream_mode: opts?.streamMode,
      },
    });
  }

  /**
   * Delete a run.
   *
   * @param threadId The ID of the thread.
   * @param runId The ID of the run.
   * @returns
   */
  async delete(
    threadId: string,
    runId: string,
    options?: { signal?: AbortSignal }
  ): Promise<void> {
    return this.fetch<void>(`/threads/${threadId}/runs/${runId}`, {
      method: "DELETE",
      signal: options?.signal,
    });
  }
}

interface APIItem {
  namespace: string[];
  key: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: Record<string, any>;
  created_at: string;
  updated_at: string;
}
interface APISearchItemsResponse {
  items: APIItem[];
}

export class StoreClient extends BaseClient {
  /**
   * Store or update an item.
   *
   * @param namespace A list of strings representing the namespace path.
   * @param key The unique identifier for the item within the namespace.
   * @param value A dictionary containing the item's data.
   * @param options.index Controls search indexing - null (use defaults), false (disable), or list of field paths to index.
   * @param options.ttl Optional time-to-live in minutes for the item, or null for no expiration.
   * @returns Promise<void>
   *
   * @example
   * ```typescript
   * await client.store.putItem(
   *   ["documents", "user123"],
   *   "item456",
   *   { title: "My Document", content: "Hello World" },
   *   { ttl: 60 } // expires in 60 minutes
   * );
   * ```
   */
  async putItem(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
    options?: {
      index?: false | string[] | null;
      ttl?: number | null;
      signal?: AbortSignal;
    }
  ): Promise<void> {
    namespace.forEach((label) => {
      if (label.includes(".")) {
        throw new Error(
          `Invalid namespace label '${label}'. Namespace labels cannot contain periods ('.')`
        );
      }
    });

    const payload = {
      namespace,
      key,
      value,
      index: options?.index,
      ttl: options?.ttl,
    };

    return this.fetch<void>("/store/items", {
      method: "PUT",
      json: payload,
      signal: options?.signal,
    });
  }

  /**
   * Retrieve a single item.
   *
   * @param namespace A list of strings representing the namespace path.
   * @param key The unique identifier for the item.
   * @param options.refreshTtl Whether to refresh the TTL on this read operation. If null, uses the store's default behavior.
   * @returns Promise<Item>
   *
   * @example
   * ```typescript
   * const item = await client.store.getItem(
   *   ["documents", "user123"],
   *   "item456",
   *   { refreshTtl: true }
   * );
   * console.log(item);
   * // {
   * //   namespace: ["documents", "user123"],
   * //   key: "item456",
   * //   value: { title: "My Document", content: "Hello World" },
   * //   createdAt: "2024-07-30T12:00:00Z",
   * //   updatedAt: "2024-07-30T12:00:00Z"
   * // }
   * ```
   */
  async getItem(
    namespace: string[],
    key: string,
    options?: {
      refreshTtl?: boolean | null;
      signal?: AbortSignal;
    }
  ): Promise<Item | null> {
    namespace.forEach((label) => {
      if (label.includes(".")) {
        throw new Error(
          `Invalid namespace label '${label}'. Namespace labels cannot contain periods ('.')`
        );
      }
    });

    const params: Record<string, unknown> = {
      namespace: namespace.join("."),
      key,
    };

    if (options?.refreshTtl !== undefined) {
      params.refresh_ttl = options.refreshTtl;
    }

    const response = await this.fetch<APIItem>("/store/items", {
      params,
      signal: options?.signal,
    });

    return response
      ? {
          ...response,
          createdAt: response.created_at,
          updatedAt: response.updated_at,
        }
      : null;
  }

  /**
   * Delete an item.
   *
   * @param namespace A list of strings representing the namespace path.
   * @param key The unique identifier for the item.
   * @returns Promise<void>
   */
  async deleteItem(
    namespace: string[],
    key: string,
    options?: { signal?: AbortSignal }
  ): Promise<void> {
    namespace.forEach((label) => {
      if (label.includes(".")) {
        throw new Error(
          `Invalid namespace label '${label}'. Namespace labels cannot contain periods ('.')`
        );
      }
    });

    return this.fetch<void>("/store/items", {
      method: "DELETE",
      json: { namespace, key },
      signal: options?.signal,
    });
  }

  /**
   * Search for items within a namespace prefix.
   *
   * @param namespacePrefix List of strings representing the namespace prefix.
   * @param options.filter Optional dictionary of key-value pairs to filter results.
   * @param options.limit Maximum number of items to return (default is 10).
   * @param options.offset Number of items to skip before returning results (default is 0).
   * @param options.query Optional search query.
   * @param options.refreshTtl Whether to refresh the TTL on items returned by this search. If null, uses the store's default behavior.
   * @returns Promise<SearchItemsResponse>
   *
   * @example
   * ```typescript
   * const results = await client.store.searchItems(
   *   ["documents"],
   *   {
   *     filter: { author: "John Doe" },
   *     limit: 5,
   *     refreshTtl: true
   *   }
   * );
   * console.log(results);
   * // {
   * //   items: [
   * //     {
   * //       namespace: ["documents", "user123"],
   * //       key: "item789",
   * //       value: { title: "Another Document", author: "John Doe" },
   * //       createdAt: "2024-07-30T12:00:00Z",
   * //       updatedAt: "2024-07-30T12:00:00Z"
   * //     },
   * //     // ... additional items ...
   * //   ]
   * // }
   * ```
   */
  async searchItems(
    namespacePrefix: string[],
    options?: {
      filter?: Record<string, unknown>;
      limit?: number;
      offset?: number;
      query?: string;
      refreshTtl?: boolean | null;
      signal?: AbortSignal;
    }
  ): Promise<SearchItemsResponse> {
    const payload = {
      namespace_prefix: namespacePrefix,
      filter: options?.filter,
      limit: options?.limit ?? 10,
      offset: options?.offset ?? 0,
      query: options?.query,
      refresh_ttl: options?.refreshTtl,
    };

    const response = await this.fetch<APISearchItemsResponse>(
      "/store/items/search",
      {
        method: "POST",
        json: payload,
        signal: options?.signal,
      }
    );
    return {
      items: response.items.map((item) => ({
        ...item,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      })),
    };
  }

  /**
   * List namespaces with optional match conditions.
   *
   * @param options.prefix Optional list of strings representing the prefix to filter namespaces.
   * @param options.suffix Optional list of strings representing the suffix to filter namespaces.
   * @param options.maxDepth Optional integer specifying the maximum depth of namespaces to return.
   * @param options.limit Maximum number of namespaces to return (default is 100).
   * @param options.offset Number of namespaces to skip before returning results (default is 0).
   * @returns Promise<ListNamespaceResponse>
   */
  async listNamespaces(options?: {
    prefix?: string[];
    suffix?: string[];
    maxDepth?: number;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  }): Promise<ListNamespaceResponse> {
    const payload = {
      prefix: options?.prefix,
      suffix: options?.suffix,
      max_depth: options?.maxDepth,
      limit: options?.limit ?? 100,
      offset: options?.offset ?? 0,
    };

    return this.fetch<ListNamespaceResponse>("/store/namespaces", {
      method: "POST",
      json: payload,
      signal: options?.signal,
    });
  }
}

class UiClient extends BaseClient {
  private static promiseCache: Record<string, Promise<unknown> | undefined> =
    {};

  private static getOrCached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (UiClient.promiseCache[key] != null) {
      return UiClient.promiseCache[key] as Promise<T>;
    }

    const promise = fn();
    UiClient.promiseCache[key] = promise;
    return promise;
  }

  async getComponent(assistantId: string, agentName: string): Promise<string> {
    return UiClient.getOrCached(
      `${this.apiUrl}-${assistantId}-${agentName}`,
      async () => {
        let [url, init] = this.prepareFetchOptions(`/ui/${assistantId}`, {
          headers: {
            Accept: "text/html",
            "Content-Type": "application/json",
          },
          method: "POST",
          json: { name: agentName },
        });
        if (this.onRequest != null) init = await this.onRequest(url, init);

        const response = await this.asyncCaller.fetch(url.toString(), init);
        return response.text();
      }
    );
  }
}

export class Client<
  TStateType = DefaultValues,
  TUpdateType = TStateType,
  TCustomEventType = unknown
> {
  /**
   * The client for interacting with assistants.
   */
  public assistants: AssistantsClient;

  /**
   * The client for interacting with threads.
   */
  public threads: ThreadsClient<TStateType, TUpdateType>;

  /**
   * The client for interacting with runs.
   */
  public runs: RunsClient<TStateType, TUpdateType, TCustomEventType>;

  /**
   * The client for interacting with cron runs.
   */
  public crons: CronsClient;

  /**
   * The client for interacting with the KV store.
   */
  public store: StoreClient;

  /**
   * The client for interacting with the UI.
   * @internal Used by LoadExternalComponent and the API might change in the future.
   */
  public "~ui": UiClient;

  /**
   * @internal Used to obtain a stable key representing the client.
   */
  private "~configHash": string | undefined;

  constructor(config?: ClientConfig) {
    this["~configHash"] = (() =>
      JSON.stringify({
        apiUrl: config?.apiUrl,
        apiKey: config?.apiKey,
        timeoutMs: config?.timeoutMs,
        defaultHeaders: config?.defaultHeaders,

        maxConcurrency: config?.callerOptions?.maxConcurrency,
        maxRetries: config?.callerOptions?.maxRetries,

        callbacks: {
          onFailedResponseHook:
            config?.callerOptions?.onFailedResponseHook != null,
          onRequest: config?.onRequest != null,
          fetch: config?.callerOptions?.fetch != null,
        },
      }))();

    this.assistants = new AssistantsClient(config);
    this.threads = new ThreadsClient(config);
    this.runs = new RunsClient(config);
    this.crons = new CronsClient(config);
    this.store = new StoreClient(config);
    this["~ui"] = new UiClient(config);
  }
}

/**
 * @internal Used to obtain a stable key representing the client.
 */
export function getClientConfigHash(client: Client): string | undefined {
  return client["~configHash"];
}
