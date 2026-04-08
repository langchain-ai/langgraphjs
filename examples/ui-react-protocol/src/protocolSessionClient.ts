import {
  BytesLineDecoder,
  IterableReadableStream,
  SSEDecoder,
  isProtocolErrorResponse,
  type ProtocolCommandResponse,
  type ProtocolEventMessage,
  type ProtocolOpenSessionResponse,
} from "@langchain/langgraph-sdk/utils";

import type { ProtocolTransportMode } from "./protocolTransport";

export type SessionProtocolChannel = "lifecycle" | "messages" | "tools";

type ProtocolCommand = {
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

type SubscriptionSpec = {
  channels: SessionProtocolChannel[];
  namespaces?: string[][];
  depth?: number;
  onEvent: (event: ProtocolEventMessage) => void;
};

type RunInputPayload = {
  input: unknown;
  config: unknown;
  metadata?: unknown;
  command?: unknown;
};

type SessionClientOptions = {
  apiUrl: string;
  assistantId: string;
};

type ListenerRecord = {
  channels: Set<SessionProtocolChannel>;
  namespaces?: string[][];
  depth?: number;
  onEvent: (event: ProtocolEventMessage) => void;
};

export type ProtocolSessionClient = {
  open: () => Promise<void>;
  subscribe: (
    spec: SubscriptionSpec
  ) => Promise<{ subscriptionId: string; unsubscribe: () => Promise<void> }>;
  runInput: (payload: RunInputPayload) => Promise<{ runId: string }>;
  close: () => Promise<void>;
};

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

const buildSubscribeCommand = (
  id: number,
  spec: Omit<SubscriptionSpec, "onEvent">
): ProtocolCommand => ({
  id,
  method: "subscription.subscribe",
  params: {
    channels: spec.channels,
    ...(spec.namespaces != null ? { namespaces: spec.namespaces } : {}),
    ...(spec.depth != null ? { depth: spec.depth } : {}),
  },
});

const buildUnsubscribeCommand = (
  id: number,
  subscriptionId: string
): ProtocolCommand => ({
  id,
  method: "subscription.unsubscribe",
  params: { subscriptionId },
});

const buildRunInputCommand = (
  id: number,
  payload: RunInputPayload
): ProtocolCommand => ({
  id,
  method: "run.input",
  params: {
    input:
      isRecord(payload.command) &&
      "resume" in payload.command &&
      payload.input == null
        ? payload.command.resume
        : payload.input ?? null,
    config: payload.config,
    metadata: payload.metadata,
  },
});

const toSessionApiUrl = (apiUrl: string, path: string) => {
  const url = new URL(path, apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`);
  return url.toString();
};

const toWebSocketUrl = (apiUrl: string) => {
  const url = new URL(apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v2/runs";
  url.search = "";
  url.hash = "";
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

const parseSubscriptionId = (response: ProtocolCommandResponse) => {
  if (isProtocolErrorResponse(response)) {
    throw new Error(`Protocol subscribe failed: ${response.message}`);
  }

  const subscriptionId =
    isRecord(response.result) && typeof response.result.subscriptionId === "string"
      ? response.result.subscriptionId
      : undefined;

  if (!subscriptionId) {
    throw new Error("Protocol subscribe did not return a subscription ID.");
  }

  return subscriptionId;
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

const startsWithNamespace = (namespace: string[], prefix: string[]) =>
  prefix.every((part, index) => namespace[index] === part);

const matchesListener = (
  event: ProtocolEventMessage,
  listener: ListenerRecord
) => {
  if (!listener.channels.has(event.method as SessionProtocolChannel)) {
    return false;
  }

  if (listener.namespaces == null || listener.namespaces.length === 0) {
    return true;
  }

  return listener.namespaces.some((prefix) => {
    if (!startsWithNamespace(event.params.namespace, prefix)) {
      return false;
    }

    if (listener.depth == null) return true;
    return event.params.namespace.length - prefix.length <= listener.depth;
  });
};

abstract class BaseProtocolSessionClient implements ProtocolSessionClient {
  protected sessionId: string | null = null;

  protected closed = false;

  private openPromise: Promise<void> | null = null;

  private nextCommandId = 1;

  private readonly listeners = new Map<string, ListenerRecord>();

  private readonly pendingListeners = new Map<string, ListenerRecord>();

  constructor(protected readonly options: SessionClientOptions) {}

  async open() {
    if (this.openPromise != null) {
      await this.openPromise;
      return;
    }

    this.openPromise = this.doOpen();
    await this.openPromise;
  }

  async subscribe(spec: SubscriptionSpec) {
    await this.open();

    const commandId = this.nextCommandId++;
    const pendingKey = `pending:${commandId}`;
    const listener: ListenerRecord = {
      channels: new Set(spec.channels),
      namespaces: spec.namespaces,
      depth: spec.depth,
      onEvent: spec.onEvent,
    };

    this.pendingListeners.set(pendingKey, listener);

    let subscriptionId: string;
    try {
      const response = await this.sendCommand(buildSubscribeCommand(commandId, spec));
      subscriptionId = parseSubscriptionId(response);
    } catch (error) {
      this.pendingListeners.delete(pendingKey);
      throw error;
    }

    this.pendingListeners.delete(pendingKey);
    this.listeners.set(subscriptionId, listener);

    let unsubscribed = false;
    return {
      subscriptionId,
      unsubscribe: async () => {
        if (unsubscribed) return;
        unsubscribed = true;
        this.listeners.delete(subscriptionId);

        if (this.closed) return;
        try {
          await this.sendCommand(
            buildUnsubscribeCommand(this.nextCommandId++, subscriptionId)
          );
        } catch {
          // Ignore best-effort cleanup failures during close/race conditions.
        }
      },
    };
  }

  async runInput(payload: RunInputPayload) {
    await this.open();
    const response = await this.sendCommand(
      buildRunInputCommand(this.nextCommandId++, payload)
    );
    return { runId: parseRunId(response) };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.pendingListeners.clear();
    await this.doClose();
  }

  protected dispatchEvent(event: ProtocolEventMessage) {
    for (const listener of this.pendingListeners.values()) {
      if (matchesListener(event, listener)) {
        listener.onEvent(event);
      }
    }

    for (const listener of this.listeners.values()) {
      if (matchesListener(event, listener)) {
        listener.onEvent(event);
      }
    }
  }

  protected abstract doOpen(): Promise<void>;

  protected abstract sendCommand(
    command: ProtocolCommand
  ): Promise<ProtocolCommandResponse>;

  protected abstract doClose(): Promise<void>;
}

class ProtocolSseSessionClient extends BaseProtocolSessionClient {
  private abortController: AbortController | null = null;

  private eventsResponsePromise: Promise<void> | null = null;

  protected async doOpen() {
    this.abortController = new AbortController();

    const openResponse = await fetch(
      toSessionApiUrl(this.options.apiUrl, "/v2/sessions"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          createSessionOpenCommand(this.options.assistantId, "sse-http")
        ),
        signal: this.abortController.signal,
      }
    );
    if (!openResponse.ok) {
      throw new Error(`Failed to open protocol session: ${openResponse.statusText}`);
    }

    const openBody = parseProtocolOpenResponse(await openResponse.json());
    this.sessionId = openBody.result.sessionId;
    const eventsUrl =
      typeof openBody.result.eventsUrl === "string"
        ? toSessionApiUrl(this.options.apiUrl, openBody.result.eventsUrl)
        : toSessionApiUrl(
            this.options.apiUrl,
            `/v2/sessions/${this.sessionId}/events`
          );

    const response = await fetch(eventsUrl, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal: this.abortController.signal,
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

    this.eventsResponsePromise = (async () => {
      try {
        for await (const event of iterable) {
          const payload = event.data;
          if (isRecord(payload) && payload.type === "event") {
            this.dispatchEvent(payload as ProtocolEventMessage);
          }
        }
      } catch (error) {
        if (
          this.abortController?.signal.aborted ||
          this.closed ||
          error instanceof DOMException
        ) {
          return;
        }
        throw error;
      }
    })();
  }

  protected async sendCommand(command: ProtocolCommand) {
    if (this.sessionId == null || this.abortController == null) {
      throw new Error("Protocol session is not open.");
    }

    const response = await fetch(
      toSessionApiUrl(this.options.apiUrl, `/v2/sessions/${this.sessionId}/commands`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
        signal: this.abortController.signal,
      }
    );
    if (!response.ok) {
      throw new Error(`Protocol command failed: ${response.statusText}`);
    }
    return (await response.json()) as ProtocolCommandResponse;
  }

  protected async doClose() {
    const controller = this.abortController;
    const sessionId = this.sessionId;

    controller?.abort();
    this.abortController = null;
    this.sessionId = null;

    if (sessionId != null) {
      await fetch(toSessionApiUrl(this.options.apiUrl, `/v2/sessions/${sessionId}`), {
        method: "DELETE",
      }).catch(() => undefined);
    }

    await this.eventsResponsePromise?.catch(() => undefined);
  }
}

class ProtocolWebSocketSessionClient extends BaseProtocolSessionClient {
  private socket: WebSocket | null = null;

  private readonly responseWaiters = new Map<
    number,
    {
      resolve: (response: ProtocolCommandResponse) => void;
      reject: (error: Error) => void;
    }
  >();

  private socketOpenPromise: Promise<void> | null = null;

  protected async doOpen() {
    this.socket = new WebSocket(toWebSocketUrl(this.options.apiUrl));

    this.socketOpenPromise = new Promise<void>((resolve, reject) => {
      this.socket?.addEventListener("open", () => resolve(), { once: true });
      this.socket?.addEventListener(
        "error",
        () => reject(new Error("Failed to open protocol WebSocket.")),
        { once: true }
      );
    });

    this.socket.addEventListener("message", (event) => {
      let payload: unknown;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (isRecord(payload) && payload.type === "event") {
        this.dispatchEvent(payload as ProtocolEventMessage);
        return;
      }

      if (
        isRecord(payload) &&
        typeof payload.id === "number" &&
        this.responseWaiters.has(payload.id)
      ) {
        const waiter = this.responseWaiters.get(payload.id);
        this.responseWaiters.delete(payload.id);
        waiter?.resolve(payload as ProtocolCommandResponse);
      }
    });

    const rejectWaiters = () => {
      for (const waiter of this.responseWaiters.values()) {
        waiter.reject(new Error("WebSocket protocol session closed unexpectedly."));
      }
      this.responseWaiters.clear();
    };

    this.socket.addEventListener("close", rejectWaiters);
    this.socket.addEventListener("error", rejectWaiters);

    await this.socketOpenPromise;

    const openResponse = await this.sendCommand(
      createSessionOpenCommand(this.options.assistantId, "websocket")
    );
    if (isProtocolErrorResponse(openResponse)) {
      throw new Error(`Protocol session open failed: ${openResponse.message}`);
    }

    const sessionId =
      isRecord(openResponse.result) &&
      typeof openResponse.result.sessionId === "string"
        ? openResponse.result.sessionId
        : null;

    if (sessionId == null) {
      throw new Error("Protocol session did not return a session ID.");
    }

    this.sessionId = sessionId;
  }

  protected sendCommand(command: ProtocolCommand) {
    if (this.socket == null || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Protocol WebSocket session is not open.");
    }

    return new Promise<ProtocolCommandResponse>((resolve, reject) => {
      this.responseWaiters.set(command.id, { resolve, reject });
      this.socket?.send(JSON.stringify(command));
    });
  }

  protected async doClose() {
    this.sessionId = null;

    const socket = this.socket;
    this.socket = null;

    for (const waiter of this.responseWaiters.values()) {
      waiter.reject(new Error("WebSocket protocol session closed."));
    }
    this.responseWaiters.clear();

    if (
      socket != null &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING)
    ) {
      socket.close();
    }
  }
}

export const createProtocolSessionClient = (
  mode: ProtocolTransportMode,
  options: SessionClientOptions
): ProtocolSessionClient =>
  mode === "websocket"
    ? new ProtocolWebSocketSessionClient(options)
    : new ProtocolSseSessionClient(options);
