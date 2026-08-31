/**
 * `fetch` wrapper that gives `/stream/events` the durable replay semantics of
 * LangGraph Platform: every connection that opens without a `since` cursor
 * receives the thread's full event history before its live events.
 *
 * The embedded dev server used by these tests drops its buffered events on
 * resume, so a reconnect there never replays the `input.requested` of an
 * already-resolved interrupt. Platform keeps that history, which is what makes
 * a resolved interrupt re-surface on the next run. Recording the frames here
 * and re-emitting them on later opens reproduces that on the wire, leaving the
 * SDK to do the filtering it does in production.
 */

interface RecordedFrame {
  eventId: string;
  seq: number;
  method: string;
  raw: string;
}

function requestHref(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function eventStreamThreadId(href: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(href, "http://localhost").pathname;
  } catch {
    pathname = href;
  }
  const match = /\/threads\/([^/]+)\/stream\/events$/.exec(pathname);
  return match?.[1] ?? null;
}

function parseFrame(raw: string): RecordedFrame | null {
  let eventId: string | undefined;
  let method: string | undefined;
  let data: string | undefined;
  for (const line of raw.split("\n")) {
    if (line.startsWith("id:")) eventId = line.slice(3).trim();
    else if (line.startsWith("event:")) method = line.slice(6).trim();
    else if (line.startsWith("data:")) data = line.slice(5).trim();
  }
  if (eventId == null || method == null || data == null) return null;
  let seq = 0;
  try {
    seq = Number((JSON.parse(data) as { seq?: unknown }).seq ?? 0);
  } catch {
    return null;
  }
  return { eventId, seq, method, raw };
}

/** `input.requested` belongs to the `input` channel, and so on. */
function frameChannel(method: string): string {
  return method.split(".")[0];
}

export interface DurableReplayFetchOptions {
  baseFetch?: typeof fetch;
  /**
   * Event methods kept in the durable history. Defaults to the interrupt
   * requests, which is what the dev server discards on resume; replaying
   * whole lifecycles would re-drive run state the dev server already
   * delivers correctly.
   */
  methods?: string[];
}

export interface DurableReplayFetch {
  /** Custom fetch suitable for `useStream({ fetch })`. */
  fetch: typeof fetch;
  /** Number of `/stream/events` opens observed (includes reconnects). */
  eventStreamOpenCount: () => number;
  /** Number of historical frames replayed across all opens. */
  replayedFrameCount: () => number;
}

export function createDurableReplayFetch(
  options: DurableReplayFetchOptions = {}
): DurableReplayFetch {
  const baseFetch = options.baseFetch ?? globalThis.fetch.bind(globalThis);
  const methods = new Set(options.methods ?? ["input.requested"]);
  const history = new Map<string, RecordedFrame[]>();
  let eventStreamOpens = 0;
  let replayedFrames = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const threadId = eventStreamThreadId(requestHref(input));
    if (threadId == null) return baseFetch(input, init);

    eventStreamOpens += 1;
    const response = await baseFetch(input, init);
    if (response.body == null) return response;

    let channels: string[] | undefined;
    let since: number | undefined;
    try {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        channels?: string[];
        since?: number;
      };
      channels = body.channels;
      since = body.since;
    } catch {
      // Unparseable body: replay everything recorded.
    }

    const recorded = history.get(threadId) ?? [];
    history.set(threadId, recorded);
    const replay = recorded.filter(
      (frame) =>
        (since == null || frame.seq > since) &&
        (channels == null || channels.includes(frameChannel(frame.method)))
    );

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let pending = "";

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const frame of replay) {
          replayedFrames += 1;
          controller.enqueue(encoder.encode(`${frame.raw}\n\n`));
        }
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
        pending += decoder.decode(value, { stream: true });
        const parts = pending.split("\n\n");
        pending = parts.pop() ?? "";
        for (const part of parts) {
          const frame = parseFrame(part);
          if (frame == null || !methods.has(frame.method)) continue;
          if (recorded.some((seen) => seen.eventId === frame.eventId)) continue;
          recorded.push(frame);
        }
      },
      cancel(reason) {
        void reader.cancel(reason);
      },
    });

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  return {
    fetch: fetchImpl,
    eventStreamOpenCount: () => eventStreamOpens,
    replayedFrameCount: () => replayedFrames,
  };
}
