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

function commandsThreadId(href: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(href, "http://localhost").pathname;
  } catch {
    pathname = href;
  }
  const match = /\/threads\/([^/]+)\/commands$/.exec(pathname);
  return match?.[1] ?? null;
}

/** `run_id` of a `run.start` command response, if the body is one. */
async function runIdFromCommandResponse(
  response: Response
): Promise<string | undefined> {
  try {
    const body = (await response.clone().json()) as {
      result?: { run_id?: unknown };
    };
    return typeof body.result?.run_id === "string"
      ? body.result.run_id
      : undefined;
  } catch {
    return undefined;
  }
}

function isRootLifecycle(frame: RecordedFrame): boolean {
  if (frame.method !== "lifecycle") return false;
  for (const line of frame.raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const namespace = (
        JSON.parse(line.slice(5).trim()) as {
          params?: { namespace?: unknown[] };
        }
      ).params?.namespace;
      return Array.isArray(namespace) && namespace.length === 0;
    } catch {
      return false;
    }
  }
  return false;
}

/** Give a frame the `synth:<run_id>:<seq>` event id LangGraph Platform uses. */
function withSynthesizedId(frame: RecordedFrame, runId: string): string {
  const eventId = `synth:${runId}:${frame.seq}`;
  return frame.raw
    .split("\n")
    .map((line) => {
      if (line.startsWith("id:")) return `id: ${eventId}`;
      if (!line.startsWith("data:")) return line;
      // The SDK reads the id from the payload, not the SSE `id:` field.
      const data = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
      return `data: ${JSON.stringify({ ...data, event_id: eventId })}`;
    })
    .join("\n");
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
  /**
   * Deliver root `lifecycle` frames under `synth:<run_id>:<seq>` event ids,
   * the only run identity LangGraph Platform puts on them. The embedded dev
   * server numbers events instead, so a terminal of an earlier run that it
   * replays to a new stream can't be told apart from the current run's.
   *
   * A frame keeps the run it was first seen under: the run whose
   * `run.start` (or `input.respond`) this fetch saw answered last. Frames
   * that arrive while such a command is in flight keep their numeric id.
   */
  synthesizeRunIds?: boolean;
  /**
   * Drop `checkpoints` frames for events a new stream replays, so replayed
   * `values` arrive without their checkpoint envelope, as they do on
   * LangGraph Platform. A frame counts as replayed when an earlier stream
   * on the thread already delivered its `seq`.
   */
  stripReplayedCheckpoints?: boolean;
  /**
   * Wait this long before each replayed frame. The dev server writes its
   * whole replay at once, so the client applies it in a single tick; over a
   * real network it arrives spread out and every step of it renders.
   */
  replayFrameDelayMs?: number;
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
  /** Per thread: the run started last, unset while a start is in flight. */
  const latestRunId = new Map<string, string>();
  /** Per thread: the run each root lifecycle frame was first seen under. */
  const runIdBySeq = new Map<string, Map<number, string>>();

  const runIdForFrame = (
    threadId: string,
    frame: RecordedFrame
  ): string | undefined => {
    let bySeq = runIdBySeq.get(threadId);
    if (bySeq == null) {
      bySeq = new Map();
      runIdBySeq.set(threadId, bySeq);
    }
    const runId = bySeq.get(frame.seq) ?? latestRunId.get(threadId);
    if (runId != null) bySeq.set(frame.seq, runId);
    return runId;
  };

  /** Per thread: the highest `seq` any stream has delivered. */
  const deliveredThrough = new Map<string, number>();
  const rewritesFrames =
    options.synthesizeRunIds === true ||
    options.stripReplayedCheckpoints === true ||
    (options.replayFrameDelayMs ?? 0) > 0;

  /** The frame as this stream delivers it, or `null` to drop it. */
  const deliver = (
    threadId: string,
    raw: string,
    replayedThrough: number
  ): string | null => {
    const frame = parseFrame(raw);
    if (frame == null) return raw;
    deliveredThrough.set(
      threadId,
      Math.max(deliveredThrough.get(threadId) ?? 0, frame.seq)
    );
    if (
      options.stripReplayedCheckpoints &&
      frame.method === "checkpoints" &&
      frame.seq <= replayedThrough
    ) {
      return null;
    }
    if (!options.synthesizeRunIds || !isRootLifecycle(frame)) return raw;
    const runId = runIdForFrame(threadId, frame);
    return runId == null ? raw : withSynthesizedId(frame, runId);
  };
  let eventStreamOpens = 0;
  let replayedFrames = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const href = requestHref(input);
    const commandsThread = commandsThreadId(href);
    if (
      commandsThread != null &&
      options.synthesizeRunIds &&
      /"method":"(run\.start|input\.respond)"/.test(String(init?.body ?? ""))
    ) {
      latestRunId.delete(commandsThread);
      const response = await baseFetch(input, init);
      const runId = await runIdFromCommandResponse(response);
      if (runId != null) latestRunId.set(commandsThread, runId);
      return response;
    }

    const threadId = eventStreamThreadId(href);
    if (threadId == null) return baseFetch(input, init);

    eventStreamOpens += 1;
    const replayedThrough = deliveredThrough.get(threadId) ?? 0;
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
          const raw = rewritesFrames
            ? deliver(threadId, frame.raw, replayedThrough)
            : frame.raw;
          if (raw != null) controller.enqueue(encoder.encode(`${raw}\n\n`));
        }
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          if (rewritesFrames && pending !== "") {
            controller.enqueue(encoder.encode(pending));
          }
          controller.close();
          return;
        }
        // Rewriting needs whole frames; otherwise pass bytes through.
        if (!rewritesFrames) controller.enqueue(value);
        pending += decoder.decode(value, { stream: true });
        const parts = pending.split("\n\n");
        pending = parts.pop() ?? "";
        for (const part of parts) {
          if (rewritesFrames) {
            const seq = parseFrame(part)?.seq ?? Number.POSITIVE_INFINITY;
            if (options.replayFrameDelayMs && seq <= replayedThrough) {
              await new Promise((resolve) =>
                setTimeout(resolve, options.replayFrameDelayMs)
              );
            }
            const raw = deliver(threadId, part, replayedThrough);
            if (raw != null) controller.enqueue(encoder.encode(`${raw}\n\n`));
          }
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
