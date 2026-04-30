import type { HeaderValue } from "./types.js";
import type { CommandResponse, ErrorResponse } from "@langchain/protocol";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const toAbsoluteUrl = (apiUrl: string, path: string) =>
  new URL(path, apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`);

export const toError = (error: unknown) =>
  // oxlint-disable-next-line no-instanceof/no-instanceof
  error instanceof Error ? error : new Error(String(error));

export const toWebSocketUrl = (apiUrl: string): string => {
  // Extract path from the input (e.g. "http://host/threads/X/stream") and
  // swap the scheme to ws/wss. The caller passes a fully-formed URL
  // with the desired path.
  const url = new URL(apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = "";
  url.hash = "";
  return url.toString();
};

export const hasHeaders = (headers?: Record<string, HeaderValue>) =>
  Object.values(headers ?? {}).some((value) => value != null);

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

export function isProtocolResponse(
  value: unknown
): value is CommandResponse | ErrorResponse {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    (value.type === "success" || value.type === "error")
  );
}
