import { AsyncCaller, AsyncCallerParams } from "../utils/async_caller.js";
import { getEnvironmentVariable } from "../utils/env.js";
import { mergeSignals } from "../utils/signals.js";
import { BytesLineDecoder, SSEDecoder } from "../utils/sse.js";
import {
  streamWithRetry,
  idleReconnectStream,
  type IdleReconnectMode,
  StreamRequestParams,
} from "../utils/stream.js";
import type { StreamProtocol } from "../types.js";

export type HeaderValue = string | undefined | null;

export function* iterateHeaders(
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

      if (shouldClear && !didClear) {
        didClear = true;
        yield [name, null];
      }
      yield [name, value];
    }
  }
}

export function mergeHeaders(
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
  if (apiKey === null) {
    return undefined;
  }

  if (apiKey) {
    return apiKey;
  }

  const prefixes = ["LANGGRAPH", "LANGSMITH", "LANGCHAIN"];

  for (const prefix of prefixes) {
    const envKey = getEnvironmentVariable(`${prefix}_API_KEY`);
    if (envKey) {
      return envKey.trim().replace(/^["']|["']$/g, "");
    }
  }

  return undefined;
}

export type RequestHook = (
  url: URL,
  init: RequestInit
) => Promise<RequestInit> | RequestInit;

/**
 * Configuration for {@link BaseClient} and the exported LangGraph SDK
 * {@link Client}.
 */
export interface ClientConfig {
  /**
   * Base URL of the LangGraph API server.
   *
   * Defaults to `http://localhost:8123`, unless the runtime provides a
   * `langgraph_api:url` global override.
   */
  apiUrl?: string;
  /**
   * API key for authentication.
   * - If a string is provided, that key will be used
   * - If undefined (default), the key will be auto-loaded from environment variables (LANGGRAPH_API_KEY, LANGSMITH_API_KEY, or LANGCHAIN_API_KEY)
   * - If null, no API key will be set (skips auto-loading)
   */
  apiKey?: string | null;
  /**
   * Options forwarded to the internal {@link AsyncCaller}, such as retry,
   * concurrency, or custom `fetch` behavior.
   */
  callerOptions?: AsyncCallerParams;
  /**
   * Default timeout, in milliseconds, applied to client requests.
   *
   * Per-request `timeoutMs` values override this default. Passing `null`
   * at the request level disables the configured timeout for that request.
   */
  timeoutMs?: number;
  /**
   * Headers applied to every request.
   *
   * The configured API key, when present, is added as the `x-api-key`
   * header after these defaults are initialized.
   */
  defaultHeaders?: Record<string, HeaderValue>;
  /**
   * Hook for inspecting or mutating a request before it is sent.
   *
   * Receives the resolved URL and prepared `RequestInit`; return the
   * original init or a replacement object to continue the request.
   */
  onRequest?: RequestHook;
  /**
   * Streaming protocol used by stream-capable endpoints.
   *
   * Defaults to `"legacy"` for backwards compatibility.
   */
  streamProtocol?: StreamProtocol;
}

export class BaseClient {
  protected asyncCaller: AsyncCaller;

  protected timeoutMs: number | undefined;

  protected apiUrl: string;

  protected defaultHeaders: Record<string, HeaderValue>;

  protected onRequest?: RequestHook;

  protected streamProtocol: StreamProtocol;

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

    this.apiUrl = config?.apiUrl?.replace(/\/$/, "") || defaultApiUrl;
    this.defaultHeaders = config?.defaultHeaders || {};
    this.onRequest = config?.onRequest;
    this.streamProtocol = config?.streamProtocol ?? "legacy";
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
      dedupe?: boolean;
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

    if ("dedupe" in mutatedOptions) {
      delete mutatedOptions.dedupe;
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
      dedupe?: boolean;
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
      dedupe?: boolean;
    }
  ): Promise<T | [T, Response]> {
    const [url, init] = this.prepareFetchOptions(path, options);

    /**
     * Coalesce concurrent, identical idempotent reads onto a single
     * in-flight request. Only engaged when the caller opts in
     * (`dedupe: true`), is not asking for the raw `Response`, did not
     * supply its own `AbortSignal` (sharing a request across consumers
     * must never let one consumer's abort cancel another's), and no
     * `onRequest` hook is configured.
     *
     * `onRequest` is excluded because it can inject per-request headers
     * (e.g. a freshly-minted `Authorization` bearer) that are not
     * visible until *after* it runs — i.e. after the dedupe key is
     * computed — so two requests that look identical here could be sent
     * with different credentials. Coalescing them would let one
     * consumer receive a response fetched with another's auth.
     */
    const canDedupe =
      options?.dedupe === true &&
      options?.withResponse !== true &&
      options?.signal == null &&
      this.onRequest == null;

    if (canDedupe) {
      const body = typeof init.body === "string" ? init.body : "";
      /**
       * The key must capture the FULL request identity, including every
       * prepared header. `inFlightReads` is module-scoped across all
       * `Client` instances, so omitting headers would let two clients
       * pointed at the same URL/thread but using different credentials
       * (Authorization, custom auth headers, tenant-scoping defaults, …)
       * share one in-flight promise — a cross-tenant data leak.
       */
      const headers = serializeHeaders(init.headers);
      const key = `${init.method ?? "GET"} ${url.toString()} ${body} ${headers}`;
      const existing = inFlightReads.get(key);
      if (existing != null) return existing as Promise<T>;

      const promise = this.#performFetch<T>(url, init);
      inFlightReads.set(key, promise);
      const clear = () => {
        if (inFlightReads.get(key) === promise) inFlightReads.delete(key);
      };
      promise.then(clear, clear);
      return promise;
    }

    const [body, response] = await this.#performFetchWithResponse<T>(url, init);
    if (options?.withResponse) {
      return [body, response];
    }
    return body;
  }

  /**
   * Issue the prepared request (applying the `onRequest` hook) and
   * resolve the parsed body. Shared by the deduped and direct paths.
   */
  async #performFetch<T>(url: URL, init: RequestInit): Promise<T> {
    const [body] = await this.#performFetchWithResponse<T>(url, init);
    return body;
  }

  async #performFetchWithResponse<T>(
    url: URL,
    init: RequestInit
  ): Promise<[T, Response]> {
    let finalInit = init;
    if (this.onRequest) {
      finalInit = await this.onRequest(url, init);
    }

    const response = await this.asyncCaller.fetch(url.toString(), finalInit);

    const body = await (async () => {
      if (response.status === 202 || response.status === 204) {
        return undefined as T;
      }
      return response.json() as Promise<T>;
    })();

    return [body, response];
  }

  protected async *streamWithRetry<
    T extends { id?: string; event: string; data: unknown },
  >(config: {
    endpoint: string;
    method?: string;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    params?: Record<string, unknown>;
    json?: unknown;
    maxRetries?: number;
    idleReconnect?: IdleReconnectMode;
    onReconnect?: (options: {
      attempt: number;
      lastEventId?: string;
      cause: unknown;
    }) => void;
    onInitialResponse?: (response: Response) => void | Promise<void>;
  }): AsyncGenerator<T> {
    const makeRequest = async (reconnectParams?: StreamRequestParams) => {
      const requestEndpoint = reconnectParams?.reconnectPath || config.endpoint;

      const isReconnect = !!reconnectParams?.reconnectPath;
      const method = isReconnect ? "GET" : config.method || "GET";

      const requestHeaders =
        isReconnect && reconnectParams?.lastEventId
          ? { ...config.headers, "Last-Event-ID": reconnectParams.lastEventId }
          : config.headers;

      // oxlint-disable-next-line prefer-const -- init is reassigned by onRequest hook
      let [url, init] = this.prepareFetchOptions(requestEndpoint, {
        method,
        timeoutMs: null,
        signal: config.signal,
        headers: requestHeaders,
        params: config.params,
        json: isReconnect ? undefined : config.json,
      });

      if (this.onRequest != null) {
        init = await this.onRequest(url, init);
      }

      const response = await this.asyncCaller.fetch(url.toString(), init);
      if (!response.body) {
        throw new Error("Expected response body from stream endpoint");
      }

      if (!isReconnect && config.onInitialResponse) {
        await config.onInitialResponse(response);
      }

      // Insert the idle watchdog on the line stream (between the byte-line
      // decoder and the SSE decoder) so it can both reset on any line and
      // recognise `:` keep-alive heartbeats to drive `"auto"` mode. The SSE
      // decoder downstream discards those comment lines.
      const idleMode = config.idleReconnect ?? "auto";
      const enableIdle = idleMode === "auto" || idleMode > 0;

      const lines = response.body.pipeThrough(BytesLineDecoder());
      const watched = enableIdle
        ? lines.pipeThrough(idleReconnectStream({ mode: idleMode }))
        : lines;
      const stream: ReadableStream<T> = watched.pipeThrough(
        SSEDecoder()
      ) as ReadableStream<T>;

      return { response, stream };
    };

    yield* streamWithRetry(makeRequest, {
      maxRetries: config.maxRetries ?? 5,
      signal: config.signal,
      onReconnect: config.onReconnect,
    });
  }
}

export const REGEX_RUN_METADATA =
  /(\/threads\/(?<thread_id>.+))?\/runs\/(?<run_id>.+)/;

export function getRunMetadataFromResponse(
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

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Module-scoped, in-flight-only coalescing map for idempotent reads.
 *
 * Two independently-constructed clients (e.g. a React component that
 * remounts under Suspense / a reachability state flip, each minting a
 * fresh `Client`) can fire the *same* `getState` / `getHistory` read a
 * few milliseconds apart, before the first has resolved. Without
 * coalescing each pays the full round-trip — the duplicate
 * `threads/{id}/state` and `threads/{id}/history` requests seen on
 * reconnect.
 *
 * Keyed by `method + url + body + auth`, entries live only while a
 * request is in flight and are removed the moment it settles. This is
 * deliberately *not* a result cache: there is no TTL and no stored
 * payload, so it cannot serve stale data — it only ever shares a
 * promise that is already on the wire. Opt-in per call via
 * `{ dedupe: true }`, and skipped whenever the caller supplies its own
 * `AbortSignal` (so one consumer aborting can never cancel another's
 * read).
 */
const inFlightReads = new Map<string, Promise<unknown>>();

/**
 * Deterministically serialize a prepared request's headers into a
 * stable string for use in the {@link inFlightReads} dedupe key. Header
 * names are normalized and sorted so ordering differences never produce
 * a different key, and every header (not just `x-api-key`) is included
 * so requests carrying different credentials never collide.
 */
function serializeHeaders(headers: RequestInit["headers"]): string {
  const normalized = mergeHeaders(
    headers as Record<string, HeaderValue> | undefined
  );
  return Object.keys(normalized)
    .sort()
    .map((name) => `${name}:${normalized[name]}`)
    .join("\n");
}
