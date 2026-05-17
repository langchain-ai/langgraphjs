import { AsyncCaller, AsyncCallerParams } from "../utils/async_caller.js";
import { getEnvironmentVariable } from "../utils/env.js";
import { mergeSignals } from "../utils/signals.js";
import { BytesLineDecoder, SSEDecoder } from "../utils/sse.js";
import { streamWithRetry, StreamRequestParams } from "../utils/stream.js";
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

      const stream: ReadableStream<T> = response.body
        .pipeThrough(BytesLineDecoder())
        .pipeThrough(SSEDecoder()) as ReadableStream<T>;

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
