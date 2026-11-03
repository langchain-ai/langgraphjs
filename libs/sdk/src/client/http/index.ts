import { BaseClient } from "../base.js";

/**
 * Options for a request sent with {@link HttpClient}.
 */
export interface HttpRequestOptions {
  /**
   * Query parameters. `null` and `undefined` values are skipped and array
   * values are sent as repeated keys.
   */
  params?: Record<string, unknown>;
  /**
   * Headers for this request, merged over the client's default headers.
   */
  headers?: Record<string, string>;
  /**
   * Abort signal for this request.
   */
  signal?: AbortSignal;
  /**
   * Timeout in milliseconds. Overrides the client's `timeoutMs`; `null`
   * disables the timeout for this request.
   */
  timeoutMs?: number | null;
}

/**
 * Options for a request with a JSON body sent with {@link HttpClient}.
 */
export interface HttpRequestWithBodyOptions extends HttpRequestOptions {
  /**
   * Value sent as the JSON request body.
   */
  json?: unknown;
}

/**
 * Sends requests to any route of the LangGraph API server, for routes that
 * have no dedicated SDK method.
 *
 * Requests use the same URL, default headers, `onRequest` hook, timeouts,
 * retries and error handling as the other SDK clients. A non-2xx response
 * rejects with an error that has the response `status`.
 *
 * @example
 * ```typescript
 * const run = await client.http.post<Run>(
 *   `/threads/${threadId}/runs/take`,
 *   { json: { run_id: runId } }
 * );
 * ```
 */
export class HttpClient extends BaseClient {
  /**
   * Send a `GET` request.
   *
   * @param path Path relative to the API URL, starting with `/`.
   * @returns The parsed JSON response body.
   */
  async get<T = unknown>(
    path: string,
    options?: HttpRequestOptions
  ): Promise<T> {
    return this.request<T>("GET", path, options);
  }

  /**
   * Send a `POST` request.
   *
   * @param path Path relative to the API URL, starting with `/`.
   * @returns The parsed JSON response body.
   */
  async post<T = unknown>(
    path: string,
    options?: HttpRequestWithBodyOptions
  ): Promise<T> {
    return this.request<T>("POST", path, options);
  }

  /**
   * Send a `PUT` request.
   *
   * @param path Path relative to the API URL, starting with `/`.
   * @returns The parsed JSON response body.
   */
  async put<T = unknown>(
    path: string,
    options?: HttpRequestWithBodyOptions
  ): Promise<T> {
    return this.request<T>("PUT", path, options);
  }

  /**
   * Send a `PATCH` request.
   *
   * @param path Path relative to the API URL, starting with `/`.
   * @returns The parsed JSON response body.
   */
  async patch<T = unknown>(
    path: string,
    options?: HttpRequestWithBodyOptions
  ): Promise<T> {
    return this.request<T>("PATCH", path, options);
  }

  /**
   * Send a `DELETE` request.
   *
   * @param path Path relative to the API URL, starting with `/`.
   */
  async delete(
    path: string,
    options?: HttpRequestWithBodyOptions
  ): Promise<void> {
    return this.request<void>("DELETE", path, options);
  }

  private request<T>(
    method: string,
    path: string,
    options?: HttpRequestWithBodyOptions
  ): Promise<T> {
    return this.fetch<T>(path, {
      method,
      json: options?.json,
      params: options?.params,
      headers: options?.headers,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }
}
