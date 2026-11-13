import type { Client } from "../client.js";
import {
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  reconnectDelayMs,
} from "../utils/reconnect.js";

/** Why {@link followThread} returned. */
export type ThreadFollowEnd =
  /** The signal aborted. */
  | "aborted"
  /** The server has no thread stream: it answered 404. */
  | "unsupported"
  /** The server refused this thread with another 4xx. */
  | "refused"
  /** The stream failed after the client's own retries, or kept ending without an event. */
  | "failed";

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

/**
 * Follows a thread's `lifecycle` stream until `signal` aborts or the stream
 * can't go on, passing each event to `onEvent`. Each connection resumes after
 * `cursor.lastEventId`, which tracks the last event id seen. The client
 * reconnects a dropped stream itself, but not one the server ended, so that
 * one is opened again after the reconnect backoff, unless more than the
 * reconnect limit in a row ended without an event.
 */
export async function followThread(
  client: Client,
  threadId: string,
  cursor: { lastEventId?: string },
  onEvent: (event: string, data: unknown) => void,
  signal: AbortSignal
): Promise<ThreadFollowEnd> {
  for (let empty = 0; ; ) {
    let received = false;
    try {
      for await (const { id, event, data } of client.threads.joinStream(
        threadId,
        { streamMode: "lifecycle", lastEventId: cursor.lastEventId, signal }
      )) {
        if (id != null) cursor.lastEventId = id;
        received = true;
        onEvent(event, data);
      }
    } catch (error) {
      if (signal.aborted) return "aborted";
      const { status } = (error ?? {}) as { status?: unknown };
      if (status === 404) return "unsupported";
      if (typeof status === "number" && status >= 400 && status < 500) {
        return "refused";
      }
      return "failed";
    }
    if (signal.aborted) return "aborted";
    empty = received ? 0 : empty + 1;
    if (empty > DEFAULT_MAX_RECONNECT_ATTEMPTS) return "failed";
    await wait(reconnectDelayMs(empty + 1), signal);
  }
}
