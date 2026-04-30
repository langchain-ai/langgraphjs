import type { AgentServerAdapter } from "@langchain/react";

type SendCommand = Parameters<AgentServerAdapter["send"]>[0];
type SendResult = Awaited<ReturnType<AgentServerAdapter["send"]>>;
type EventStreamHandle = ReturnType<
  NonNullable<AgentServerAdapter["openEventStream"]>
>;
type SubscribeParams = Parameters<
  NonNullable<AgentServerAdapter["openEventStream"]>
>[0];
type ProtocolMessage = EventStreamHandle extends {
  events: AsyncIterable<infer Message>;
}
  ? Message
  : never;

const PROTOCOL_METHODS = new Set([
  "values",
  "checkpoints",
  "updates",
  "messages",
  "tools",
  "custom",
  "lifecycle",
  "input.requested",
  "tasks",
]);

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];

  private waiters: Array<(result: IteratorResult<T>) => void> = [];

  private closed = false;

  push(value: T) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.values.length > 0) {
          return { done: false, value: this.values.shift()! };
        }
        if (this.closed) {
          return { done: true, value: undefined };
        }
        return await new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProtocolMessage(value: unknown): value is ProtocolMessage {
  return (
    isRecord(value) &&
    value.type === "event" &&
    typeof value.method === "string" &&
    isRecord(value.params)
  );
}

function createProtocolMessage(
  eventName: string,
  data: unknown,
): ProtocolMessage | undefined {
  const [method, ...namespace] = eventName.split("|");
  if (!method) return undefined;
  const isProtocolMethod = PROTOCOL_METHODS.has(method);

  return {
    type: "event",
    method: isProtocolMethod ? method : "custom",
    params: {
      data: isProtocolMethod ? data : { name: method, payload: data },
      namespace,
    },
  } as ProtocolMessage;
}

function segmentMatches(filterSegment: string, eventSegment: string) {
  if (filterSegment.includes(":")) return filterSegment === eventSegment;
  return eventSegment.split(":")[0] === filterSegment;
}

function matchesSubscription(
  message: ProtocolMessage,
  params: SubscribeParams,
) {
  const channel = getMessageChannel(message);
  if (
    params.channels?.length &&
    !params.channels.includes(channel) &&
    !(channel.startsWith("custom:") && params.channels.includes("custom"))
  ) {
    return false;
  }

  if (!params.namespaces?.length) return true;

  const namespace = Array.isArray(message.params.namespace)
    ? message.params.namespace
    : [];

  return params.namespaces.some((prefix) => {
    if (prefix.length > namespace.length) return false;
    const prefixMatches = prefix.every((segment, index) =>
      segmentMatches(segment, namespace[index] ?? ""),
    );
    if (!prefixMatches) return false;
    return params.depth == null || namespace.length - prefix.length <= params.depth;
  });
}

function getMessageChannel(message: ProtocolMessage) {
  if (message.method !== "custom") return message.method;
  const data = message.params.data;
  return isRecord(data) && typeof data.name === "string"
    ? `custom:${data.name}`
    : "custom";
}

async function* parseSseMessages(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ProtocolMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const drain = function* (flush = false): Generator<ProtocolMessage> {
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) {
        if (!flush || buffer.length === 0) return;
        buffer += "\n\n";
        continue;
      }

      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = chunk.split("\n");
      const eventName =
        lines
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim() ?? "message";
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");

      if (!data) continue;

      const parsed = JSON.parse(data) as unknown;
      if (isProtocolMessage(parsed)) {
        yield parsed;
        continue;
      }

      const message = createProtocolMessage(eventName, parsed);
      if (message) yield message;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    yield* drain();
  }

  buffer += decoder.decode();
  yield* drain(true);
}

export class LocalStreamTransport implements AgentServerAdapter {
  readonly threadId = "local";

  private readonly apiUrl: string;

  private readonly streams = new Set<{
    params: SubscribeParams;
    queue: AsyncQueue<ProtocolMessage>;
  }>();

  private abortController: AbortController | undefined;

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl;
  }

  async open() {
    // The local HTTP bridge opens streams lazily per run.
  }

  async send(command: SendCommand): Promise<SendResult> {
    if (command.method !== "run.input") {
      return { type: "success", id: command.id, result: {} } as SendResult;
    }

    const params: Record<string, unknown> = isRecord(command.params)
      ? command.params
      : {};
    void this.startRun(params.input);

    return {
      type: "success",
      id: command.id,
      result: { run_id: crypto.randomUUID() },
    } as SendResult;
  }

  events(): AsyncIterable<ProtocolMessage> {
    return new AsyncQueue<ProtocolMessage>();
  }

  openEventStream(params: SubscribeParams): EventStreamHandle {
    const queue = new AsyncQueue<ProtocolMessage>();
    const stream = { params, queue };
    this.streams.add(stream);

    return {
      events: queue,
      ready: Promise.resolve(),
      close: () => {
        this.streams.delete(stream);
        queue.close();
      },
    };
  }

  async close() {
    this.abortController?.abort();
    for (const stream of this.streams) stream.queue.close();
    this.streams.clear();
  }

  async getState() {
    return null;
  }

  private async startRun(input: unknown) {
    this.abortController?.abort();
    this.abortController = new AbortController();

    try {
      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input }),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`Failed to stream: ${response.statusText}`);
      }
      if (!response.body) return;

      for await (const message of parseSseMessages(response.body)) {
        for (const stream of this.streams) {
          if (matchesSubscription(message, stream.params)) {
            stream.queue.push(message);
          }
        }
      }
    } catch (error) {
      if (!this.abortController.signal.aborted) {
        console.error(error);
      }
    }
  }
}
