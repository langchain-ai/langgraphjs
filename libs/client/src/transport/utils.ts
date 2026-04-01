import type { HeaderValue } from "./types.js";
import type { CommandResponse, ErrorResponse } from "@langchain/protocol";

/**
 * Returns whether a value is a non-null object.
 *
 * @param value - Value to inspect.
 * @returns Whether the value can be treated as a record.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Resolves a protocol endpoint path against the configured API base URL.
 *
 * @param apiUrl - Base API URL.
 * @param path - Relative or absolute endpoint path.
 * @returns The resolved absolute URL.
 */
export const toAbsoluteUrl = (apiUrl: string, path: string) =>
  new URL(path, apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`);

/**
 * Normalizes unknown thrown values into `Error` instances.
 *
 * @param error - Unknown thrown value.
 * @returns A normalized `Error` instance.
 */
export const toError = (error: unknown) =>
  // oxlint-disable-next-line no-instanceof/no-instanceof
  error instanceof Error ? error : new Error(String(error));

/**
 * Converts an HTTP API URL into the protocol WebSocket endpoint URL.
 *
 * @param apiUrl - Base API URL.
 * @returns The corresponding WebSocket URL.
 */
export const toWebSocketUrl = (apiUrl: string): string => {
  const url = new URL(apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v2/runs";
  url.search = "";
  url.hash = "";
  return url.toString();
};

/**
 * Returns whether any non-null header values were provided.
 *
 * @param headers - Optional header map to inspect.
 * @returns Whether at least one header value is present.
 */
export const hasHeaders = (headers?: Record<string, HeaderValue>) =>
  Object.values(headers ?? {}).some((value) => value != null);

/**
 * Merges multiple header collections into a single `Headers` instance.
 *
 * @param headerGroups - Header collections to merge in order.
 * @returns The merged headers.
 */
export function mergeHeaders(
  ...headerGroups: Array<
    HeadersInit | Record<string, HeaderValue> | undefined | null
  >
): Headers {
  const merged = new Headers();

  for (const group of headerGroups) {
    if (!group) {
      continue;
    }

    // oxlint-disable-next-line no-instanceof/no-instanceof
    if (group instanceof Headers) {
      group.forEach((value, key) => {
        merged.set(key, value);
      });
      continue;
    }

    if (Array.isArray(group)) {
      for (const [key, value] of group) {
        if (value == null) {
          merged.delete(key);
        } else {
          merged.set(key, value);
        }
      }
      continue;
    }

    for (const [key, value] of Object.entries(group)) {
      if (value == null) {
        merged.delete(key);
      } else {
        merged.set(key, value);
      }
    }
  }

  return merged;
}

/**
 * Returns whether a parsed JSON payload matches a protocol command response.
 *
 * @param value - Parsed JSON payload.
 * @returns Whether the payload is a success or error protocol response.
 */
export function isProtocolResponse(
  value: unknown
): value is CommandResponse | ErrorResponse {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    (value.type === "success" || value.type === "error")
  );
}
