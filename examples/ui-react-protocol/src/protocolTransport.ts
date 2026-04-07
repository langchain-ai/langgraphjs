import type { UseStreamTransport } from "@langchain/langgraph-sdk/react";
import {
  BytesLineDecoder,
  SSEDecoder,
  IterableReadableStream,
  ProtocolEventAdapter,
  getProtocolChannels,
  isProtocolErrorResponse,
  type ProtocolCommandResponse,
  type ProtocolEventMessage,
  type ProtocolOpenSessionResponse,
} from "@langchain/langgraph-sdk/utils";

type StreamEvent = { id?: string; event: string; data: unknown };

export type ProtocolTransportMode = "http-sse" | "websocket";

type ProtocolCommand = {
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

type AsyncQueueResult<T> =
  | { done: false; value: T }
  | { done: true; value: undefined };

class AsyncQueue<T> {
  private readonly values: T[] = [];

  private readonly waiters: Array<(result: AsyncQueueResult<T>) => void> = [];

  private closed = false;

  push(value: T) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter != null) {
      waiter({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  async shift(): Promise<AsyncQueueResult<T>> {
    if (this.values.length > 0) {
      const value = this.values.shift() as T;
      return { done: false, value };
    }

    if (this.closed) {
      return { done: true, value: undefined };
    }

    return new Promise<AsyncQueueResult<T>>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const createSessionOpenCommand = (
  assistantId: string,
  preferredTransport: "sse-http" | "websocket"
): ProtocolCommand => ({
  id: 0,
  method: "session.open",
  params: {
    protocolVersion: "0.3.0",
    target: { kind: "agent", id: assistantId },
    preferredTransports: [preferredTransport],
  },
});

const getThreadIdFromConfig = (config: unknown) => {
  const configurable = isRecord(config) ? config.configurable : undefined;
  return isRecord(configurable) && typeof configurable.thread_id === "string"
    ? configurable.thread_id
    : undefined;
};

const toWebSocketUrl = (apiUrl: string) => {
  const url = new URL(apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v2/runs";
  url.search = "";
  url.hash = "";
  return url.toString();
};

const toSessionApiUrl = (apiUrl: string, path: string) => {
  const url = new URL(path, apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`);
  return url.toString();
};

const parseProtocolOpenResponse = (value: unknown) => {
  if (!isRecord(value) || !isRecord(value.result)) {
    throw new Error("Protocol session did not return a valid open response.");
  }

  const sessionId =
    typeof value.result.sessionId === "string" ? value.result.sessionId : undefined;
  if (!sessionId) {
    throw new Error("Protocol session did not return a session ID.");
  }

  return value as ProtocolOpenSessionResponse;
};

const parseRunId = (response: ProtocolCommandResponse) => {
  if (isProtocolErrorResponse(response)) {
    throw new Error(`Protocol run failed: ${response.message}`);
  }

  const runId =
    isRecord(response.result) && typeof response.result.runId === "string"
      ? response.result.runId
      : undefined;

  if (!runId) {
    throw new Error("Protocol run did not return a run ID.");
  }

  return runId;
};

const buildSubscribeCommand = (streamSubgraphs?: boolean): ProtocolCommand => ({
  id: 1,
  method: "subscription.subscribe",
  params: {
    channels: getProtocolChannels(["messages-tuple", "values", "updates", "tools"]),
    ...(streamSubgraphs
      ? {}
      : {
          namespaces: [[]],
          depth: 0,
        }),
  },
});

const buildRunInputCommand = (payload: {
  input: unknown;
  config: unknown;
  context: unknown;
  command: unknown;
}): ProtocolCommand => ({
  id: 2,
  method: "run.input",
  params: {
    input:
      isRecord(payload.command) && "resume" in payload.command && payload.input == null
        ? payload.command.resume
        : payload.input ?? null,
    config: payload.config,
    metadata: payload.context,
  },
});

async function* adaptProtocolEvents(
  source: AsyncIterable<{ id?: string; data: unknown }>,
  options: {
    assistantId: string;
    transport: ProtocolTransportMode;
  }
): AsyncGenerator<StreamEvent> {
  const adapter = new ProtocolEventAdapter();

  for await (const chunk of source) {
    const message = isRecord(chunk.data)
      ? (chunk.data as ProtocolEventMessage)
      : undefined;
    if (message?.type !== "event") continue;
    console.log(
      "[protocol raw event]",
      JSON.stringify({
        assistantId: options.assistantId,
        transport: options.transport,
        payload: message,
      })
    );
    for (const adapted of adapter.adapt(message)) {
      console.log(
        "[protocol adapted event]",
        JSON.stringify({
          assistantId: options.assistantId,
          transport: options.transport,
          payload: adapted,
        })
      );
      yield adapted;
    }
  }
}

export class ProtocolSseTransport<
  StateType extends Record<string, unknown> = Record<string, unknown>,
> implements UseStreamTransport<StateType> {
  constructor(
    private readonly options: {
      apiUrl: string;
      assistantId: string;
      fetch?: typeof fetch;
    }
  ) {}

  async stream(payload: {
    input: unknown;
    context: unknown;
    command: unknown;
    config: unknown;
    streamSubgraphs?: boolean;
    signal: AbortSignal;
  }): Promise<AsyncGenerator<StreamEvent>> {
    const fetchImpl = this.options.fetch ?? fetch;

    const openResponse = await fetchImpl(
      toSessionApiUrl(this.options.apiUrl, "/v2/sessions"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createSessionOpenCommand(this.options.assistantId, "sse-http")),
        signal: payload.signal,
      }
    );
    if (!openResponse.ok) {
      throw new Error(`Failed to open protocol session: ${openResponse.statusText}`);
    }

    const openBody = parseProtocolOpenResponse(await openResponse.json());
    const sessionId = openBody.result.sessionId;
    const eventsUrl =
      typeof openBody.result.eventsUrl === "string"
        ? toSessionApiUrl(this.options.apiUrl, openBody.result.eventsUrl)
        : toSessionApiUrl(this.options.apiUrl, `/v2/sessions/${sessionId}/events`);

    const postCommand = async (command: ProtocolCommand) => {
      const response = await fetchImpl(
        toSessionApiUrl(this.options.apiUrl, `/v2/sessions/${sessionId}/commands`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
          signal: payload.signal,
        }
      );
      if (!response.ok) {
        throw new Error(`Protocol command failed: ${response.statusText}`);
      }
      return (await response.json()) as ProtocolCommandResponse;
    };

    const subscribeResponse = await postCommand(
      buildSubscribeCommand(payload.streamSubgraphs)
    );
    if (isProtocolErrorResponse(subscribeResponse)) {
      throw new Error(`Protocol subscribe failed: ${subscribeResponse.message}`);
    }

    const runResponse = await postCommand(
      buildRunInputCommand({
        input: payload.input,
        config: payload.config,
        context: payload.context,
        command: payload.command,
      })
    );
    const runId = parseRunId(runResponse);
    const threadId = getThreadIdFromConfig(payload.config);

    const response = await fetchImpl(eventsUrl, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal: payload.signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to attach SSE event stream: ${response.statusText}`);
    }

    const readable =
      response.body ?? new ReadableStream({ start: (controller) => controller.close() });
    const stream = readable
      .pipeThrough(BytesLineDecoder())
      .pipeThrough(SSEDecoder());

    const iterable = IterableReadableStream.fromReadableStream(stream);

    const eventSource = {
      async *[Symbol.asyncIterator]() {
        for await (const event of iterable) {
          yield { id: event.id, data: event.data };
        }
      },
    };

    const apiUrl = this.options.apiUrl;
    const deleteFetch = this.options.fetch ?? fetch;
    const assistantId = this.options.assistantId;
    return (async function* () {
      try {
        yield {
          event: "metadata",
          data: {
            run_id: runId,
            ...(threadId != null ? { thread_id: threadId } : {}),
          },
        };

        yield* adaptProtocolEvents(eventSource, {
          assistantId,
          transport: "http-sse",
        });
      } finally {
        await deleteFetch(
          toSessionApiUrl(apiUrl, `/v2/sessions/${sessionId}`),
          {
            method: "DELETE",
          }
        ).catch(() => undefined);
      }
    })();
  }
}

export class ProtocolWebSocketTransport<
  StateType extends Record<string, unknown> = Record<string, unknown>,
> implements UseStreamTransport<StateType> {
  constructor(
    private readonly options: {
      apiUrl: string;
      assistantId: string;
      webSocketFactory?: (url: string) => WebSocket;
    }
  ) {}

  async stream(payload: {
    input: unknown;
    context: unknown;
    command: unknown;
    config: unknown;
    streamSubgraphs?: boolean;
    signal: AbortSignal;
  }): Promise<AsyncGenerator<StreamEvent>> {
    const socketFactory =
      this.options.webSocketFactory ?? ((url: string) => new WebSocket(url));
    const socket = socketFactory(toWebSocketUrl(this.options.apiUrl));
    const adapter = new ProtocolEventAdapter();
    const queue = new AsyncQueue<StreamEvent>();
    const responseWaiters = new Map<
      number,
      {
        resolve: (response: ProtocolCommandResponse) => void;
        reject: (error: Error) => void;
      }
    >();

    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      queue.close();
      for (const waiter of responseWaiters.values()) {
        waiter.reject(new Error("WebSocket protocol session closed unexpectedly."));
      }
      responseWaiters.clear();
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      }
    };

    const awaitOpen = new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("Failed to open protocol WebSocket.")),
        { once: true }
      );
    });

    const sendCommand = (command: ProtocolCommand) =>
      new Promise<ProtocolCommandResponse>((resolve, reject) => {
        responseWaiters.set(command.id, { resolve, reject });
        socket.send(JSON.stringify(command));
      });

    socket.addEventListener("message", (event) => {
      let payload: unknown;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (isRecord(payload) && payload.type === "event") {
        console.log(
          "[protocol raw event]",
          JSON.stringify({
            assistantId: this.options.assistantId,
            transport: "websocket",
            payload,
          })
        );
        for (const adapted of adapter.adapt(payload as ProtocolEventMessage)) {
          console.log(
            "[protocol adapted event]",
            JSON.stringify({
              assistantId: this.options.assistantId,
              transport: "websocket",
              payload: adapted,
            })
          );
          queue.push(adapted);
        }
        return;
      }

      if (
        isRecord(payload) &&
        typeof payload.id === "number" &&
        responseWaiters.has(payload.id)
      ) {
        const waiter = responseWaiters.get(payload.id);
        responseWaiters.delete(payload.id);
        waiter?.resolve(payload as ProtocolCommandResponse);
      }
    });

    socket.addEventListener("close", cleanup);
    socket.addEventListener("error", cleanup);
    payload.signal.addEventListener("abort", cleanup, { once: true });

    await awaitOpen;

    const openResponse = await sendCommand(
      createSessionOpenCommand(this.options.assistantId, "websocket")
    );
    if (isProtocolErrorResponse(openResponse)) {
      cleanup();
      throw new Error(`Protocol session open failed: ${openResponse.message}`);
    }

    const subscribeResponse = await sendCommand(
      buildSubscribeCommand(payload.streamSubgraphs)
    );
    if (isProtocolErrorResponse(subscribeResponse)) {
      cleanup();
      throw new Error(`Protocol subscribe failed: ${subscribeResponse.message}`);
    }

    const runResponse = await sendCommand(
      buildRunInputCommand({
        input: payload.input,
        config: payload.config,
        context: payload.context,
        command: payload.command,
      })
    );
    const runId = parseRunId(runResponse);
    const threadId = getThreadIdFromConfig(payload.config);

    return (async function* () {
      try {
        yield {
          event: "metadata",
          data: {
            run_id: runId,
            ...(threadId != null ? { thread_id: threadId } : {}),
          },
        };

        while (true) {
          const next = await queue.shift();
          if (next.done) break;
          yield next.value;
        }
      } finally {
        cleanup();
      }
    })();
  }
}

export const createProtocolTransport = (
  mode: ProtocolTransportMode,
  options: { apiUrl: string; assistantId: string }
) =>
  mode === "websocket"
    ? new ProtocolWebSocketTransport(options)
    : new ProtocolSseTransport(options);
