interface RecordedFrame {
  eventId: string;
  seq: number;
  raw: string;
}

function eventStreamThreadId(input: RequestInfo | URL): string | null {
  const href =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const pathname = new URL(href, "http://localhost").pathname;
  return /\/threads\/([^/]+)\/stream\/events$/.exec(pathname)?.[1] ?? null;
}

function parseInputRequestedFrame(raw: string): RecordedFrame | null {
  const eventId = /^id:\s*(.+)$/m.exec(raw)?.[1];
  const method = /^event:\s*(.+)$/m.exec(raw)?.[1];
  const data = /^data:\s*(.+)$/m.exec(raw)?.[1];
  if (eventId == null || method !== "input.requested" || data == null) {
    return null;
  }
  return {
    eventId,
    seq: Number((JSON.parse(data) as { seq?: unknown }).seq ?? 0),
    raw,
  };
}

export function createDurableReplayFetch() {
  const baseFetch = globalThis.fetch.bind(globalThis);
  const history = new Map<string, RecordedFrame[]>();
  let replayedFrames = 0;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const threadId = eventStreamThreadId(input);
    if (threadId == null) return baseFetch(input, init);

    const response = await baseFetch(input, init);
    if (response.body == null) return response;

    const body = JSON.parse(String(init?.body ?? "{}")) as {
      channels?: string[];
      since?: number;
    };
    const recorded = history.get(threadId) ?? [];
    history.set(threadId, recorded);
    const replay =
      body.channels?.includes("input") === false
        ? []
        : recorded.filter(
            (frame) => body.since == null || frame.seq > body.since
          );

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let pending = "";

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
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
          const frame = parseInputRequestedFrame(part);
          if (
            frame != null &&
            !recorded.some((seen) => seen.eventId === frame.eventId)
          ) {
            recorded.push(frame);
          }
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

  return { fetch, replayedFrameCount: () => replayedFrames };
}
