/**
 * Auth-shim style `fetch` wrapper used to reproduce the browser HITL-idle
 * failure mode: a custom `fetch` (tenant headers / proxy) must keep SSE
 * reconnect enabled, and mid-stream drops must recover before `respond()`.
 *
 * Dropping must *error* the response body (not abort the request signal).
 * Aborting the fetch signal often ends the SSE `for await` cleanly, which
 * skips the reconnect loop in {@link ProtocolSseTransportAdapter.openEventStream}.
 */

function requestHref(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isEventStreamUrl(href: string): boolean {
  try {
    return new URL(href, "http://localhost").pathname.includes(
      "/stream/events"
    );
  } catch {
    return href.includes("/stream/events");
  }
}

export interface DroppableAuthFetch {
  /** Custom fetch suitable for `useStream({ fetch })`. */
  fetch: typeof fetch;
  /** Error every in-flight `/stream/events` body (simulates QUIC/idle drop). */
  dropActiveStreams: (reason?: unknown) => void;
  /** Number of `/stream/events` opens observed (includes reconnects). */
  eventStreamOpenCount: () => number;
}

export function createDroppableAuthFetch(
  baseFetch: typeof fetch = globalThis.fetch
): DroppableAuthFetch {
  const bodyDroppers = new Set<(reason: unknown) => void>();
  let eventStreamOpens = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const href = requestHref(input);
    if (!isEventStreamUrl(href)) {
      return baseFetch(input, init);
    }

    eventStreamOpens += 1;
    const response = await baseFetch(input, init);
    if (response.body == null) {
      return response;
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const reader = response.body.getReader();
    let dropped = false;

    const drop = (reason: unknown) => {
      if (dropped) return;
      dropped = true;
      void writer.abort(reason);
      void reader.cancel(reason);
    };
    bodyDroppers.add(drop);

    void (async () => {
      try {
        while (!dropped) {
          const { done, value } = await reader.read();
          if (done) {
            await writer.close();
            return;
          }
          await writer.write(value);
        }
      } catch (error) {
        if (!dropped) {
          try {
            await writer.abort(error);
          } catch {
            // already closed/aborted
          }
        }
      } finally {
        bodyDroppers.delete(drop);
      }
    })();

    return new Response(readable, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  return {
    fetch: fetchImpl,
    dropActiveStreams: (
      reason = new TypeError("net::ERR_QUIC_PROTOCOL_ERROR")
    ) => {
      for (const drop of [...bodyDroppers]) {
        drop(reason);
      }
    },
    eventStreamOpenCount: () => eventStreamOpens,
  };
}
