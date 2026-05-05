/**
 * Shared helpers for `examples/streaming/src/api/*.ts`.
 *
 * The scripts in this folder target a **pre-running Python langgraph-api
 * server** rather than the JS dev server (`langgraph dev`) spawned by
 * the sibling `remote.ts` examples. Launch the Python server once from
 * `langgraph-api/api`:
 *
 *     cd /path/to/langgraph-api/api && make start   # listens on :9123
 *
 * Then run any example here with:
 *
 *     npx tsx src/api/<name>.ts
 *
 * Override the URL with `LANGGRAPH_API_URL`:
 *
 *     LANGGRAPH_API_URL=http://localhost:8080 npx tsx src/api/basic.ts
 *
 * These scripts exercise the protocol endpoints shipped in the Python API:
 * `POST /threads/{thread_id}/commands`,
 * `POST /threads/{thread_id}/stream/events`, and the WebSocket at
 * `/threads/{thread_id}/stream/events`.
 */

export const DEFAULT_API_URL = "http://localhost:9123";

/** The Python langgraph-api base URL, configurable via env. */
export function apiUrl(): string {
  return process.env.LANGGRAPH_API_URL ?? DEFAULT_API_URL;
}

/** Probe the server with a short-timeout `/info` GET. Throws if unreachable. */
export async function requireServer(url: string = apiUrl()): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`${url}/info`, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(
        `langgraph-api at ${url} returned ${res.status} from /info.`
      );
    }
  } catch (err) {
    const hint =
      "Start it with `cd langgraph-api/api && make start` or set " +
      "LANGGRAPH_API_URL to point at a running instance.";
    throw new Error(`Cannot reach langgraph-api at ${url}. ${hint}\n${err}`);
  } finally {
    clearTimeout(timeout);
  }
}

/** Truncate a JSON snippet for compact console output. */
export function short(value: unknown, limit = 120): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

/**
 * Format a namespace array as `[a/b]` or empty string for root. Matches the
 * convention used in the sibling `remote.ts` examples so dashboards and
 * grep'd logs look consistent.
 */
export function nsPrefix(namespace: readonly string[]): string {
  return namespace.length > 0 ? `[${namespace.join("/")}] ` : "";
}
