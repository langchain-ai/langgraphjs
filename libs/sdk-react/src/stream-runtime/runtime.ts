import {
  ProtocolSseTransportAdapter,
  ProtocolWebSocketTransportAdapter,
  ThreadStream,
  type ProtocolRequestHook,
} from "@langchain/langgraph-sdk/client";
import type { Client, StreamProtocol } from "@langchain/langgraph-sdk";
import type { EventStreamEvent } from "@langchain/langgraph-sdk/ui";
import {
  ProtocolEventAdapter,
  getProtocolChannels,
  type ProtocolEventMessage,
} from "@langchain/langgraph-sdk/utils";
import type { StreamRuntime } from "./types.js";

type HeaderValue = string | undefined | null;

type RunsClientInternals = {
  apiUrl?: string;
  defaultHeaders?: Record<string, HeaderValue>;
  onRequest?: ProtocolRequestHook;
  asyncCaller?: {
    fetch: typeof fetch;
  };
};

type ProtocolTransportMode = "sse-http" | "websocket";

type ProtocolRuntimeConfig = ReturnType<typeof getProtocolConfig> & {
  webSocketFactory?: (url: string) => WebSocket;
};

const ROOT_NAMESPACE: string[] = [];

const isTerminalLifecycleEvent = (event: ProtocolEventMessage): boolean => {
  if (event.method !== "lifecycle") {
    return false;
  }

  if (event.params.namespace.length !== ROOT_NAMESPACE.length) {
    return false;
  }

  const data = event.params.data as { event?: unknown };
  return data?.event === "completed" || data?.event === "failed";
};

const isInterruptedLifecycleEvent = (event: ProtocolEventMessage): boolean => {
  if (event.method !== "lifecycle") {
    return false;
  }

  if (event.params.namespace.length !== ROOT_NAMESPACE.length) {
    return false;
  }

  const data = event.params.data as { event?: unknown };
  return data?.event === "interrupted";
};

const isResumeOnlyCommand = (
  command: unknown
): command is { resume: unknown } =>
  typeof command === "object" &&
  command !== null &&
  "resume" in command &&
  !("update" in command) &&
  !("goto" in command);

function getProtocolConfig(client: Client): {
  apiUrl: string;
  defaultHeaders?: Record<string, HeaderValue>;
  onRequest?: ProtocolRequestHook;
  fetch?: typeof fetch;
} {
  const runsClient = client.runs as unknown as RunsClientInternals;
  if (typeof runsClient.apiUrl !== "string") {
    throw new Error("Unable to resolve protocol transport configuration.");
  }

  return {
    apiUrl: runsClient.apiUrl,
    defaultHeaders: runsClient.defaultHeaders,
    onRequest: runsClient.onRequest,
    fetch: runsClient.asyncCaller?.fetch?.bind(runsClient.asyncCaller),
  };
}

function getProtocolTransportMode(
  streamProtocol: StreamProtocol | undefined
): ProtocolTransportMode {
  return streamProtocol === "v2-websocket" ? "websocket" : "sse-http";
}

function bindThreadConfig(
  config: unknown,
  threadId: string
): Record<string, unknown> {
  const base =
    config != null && typeof config === "object"
      ? (config as Record<string, unknown>)
      : {};
  const configurable =
    base.configurable != null && typeof base.configurable === "object"
      ? (base.configurable as Record<string, unknown>)
      : {};

  return {
    ...base,
    configurable: {
      ...configurable,
      thread_id: threadId,
    },
  };
}

export class ProtocolStreamRuntime<
  StateType extends Record<string, unknown>,
  UpdateType,
  ConfigurableType extends Record<string, unknown>,
  CustomType,
> implements StreamRuntime<
  StateType,
  UpdateType,
  ConfigurableType,
  CustomType
> {
  private readonly transportConfig: ProtocolRuntimeConfig;
  private readonly protocolTransport: ProtocolTransportMode;
  private activeThread?: ThreadStream;

  constructor(
    private readonly client: Client<StateType, UpdateType, CustomType>,
    streamProtocol: StreamProtocol | undefined,
    options?: {
      protocolFetch?: typeof fetch;
      protocolWebSocket?: (url: string) => WebSocket;
    }
  ) {
    this.protocolTransport = getProtocolTransportMode(streamProtocol);
    const transportConfig = getProtocolConfig(client);
    this.transportConfig = {
      ...transportConfig,
      fetch: options?.protocolFetch ?? transportConfig.fetch,
      webSocketFactory: options?.protocolWebSocket,
    };
  }

  async submit({
    assistantId,
    threadId,
    input,
    submitOptions,
    signal,
    streamMode,
    onRunCreated,
  }: Parameters<
    StreamRuntime<StateType, UpdateType, ConfigurableType, CustomType>["submit"]
  >[0]): Promise<
    AsyncGenerator<EventStreamEvent<StateType, UpdateType, CustomType>>
  > {
    const transport =
      this.protocolTransport === "websocket"
        ? new ProtocolWebSocketTransportAdapter({
            apiUrl: this.transportConfig.apiUrl,
            threadId,
            defaultHeaders: this.transportConfig.defaultHeaders,
            onRequest: this.transportConfig.onRequest,
            webSocketFactory: this.transportConfig.webSocketFactory,
          })
        : new ProtocolSseTransportAdapter({
            apiUrl: this.transportConfig.apiUrl,
            threadId,
            defaultHeaders: this.transportConfig.defaultHeaders,
            onRequest: this.transportConfig.onRequest,
            fetch: this.transportConfig.fetch,
          });

    const thread = new ThreadStream(transport, { assistantId });
    this.activeThread = thread;

    const boundConfig = bindThreadConfig(submitOptions?.config, threadId);

    const subscription = await thread.subscribe({
      channels: getProtocolChannels(streamMode),
    });

    const runInput =
      submitOptions?.command != null &&
      isResumeOnlyCommand(submitOptions.command)
        ? submitOptions.command.resume
        : input;

    const metadata =
      submitOptions?.metadata != null &&
      typeof submitOptions.metadata === "object"
        ? (submitOptions.metadata as Record<string, unknown>)
        : undefined;

    const runResult = await thread.run.input({
      input: runInput ?? null,
      config: boundConfig,
      metadata,
    });

    const runId = runResult.run_id;
    if (typeof runId !== "string" || runId.length === 0) {
      await thread.close().catch(() => undefined);
      throw new Error("Protocol run did not return a run ID.");
    }

    onRunCreated?.({
      run_id: runId,
      thread_id: threadId,
    });

    const closeThread = () => {
      void thread.close().catch(() => undefined);
    };
    signal.addEventListener("abort", closeThread, { once: true });

    return (async function* (
      runtime: ProtocolStreamRuntime<
        StateType,
        UpdateType,
        ConfigurableType,
        CustomType
      >
    ): AsyncGenerator<EventStreamEvent<StateType, UpdateType, CustomType>> {
      const adapter = new ProtocolEventAdapter();
      const iterator = subscription[Symbol.asyncIterator]();

      try {
        yield {
          event: "metadata",
          data: {
            run_id: runId,
            thread_id: threadId,
          },
        } as EventStreamEvent<StateType, UpdateType, CustomType>;

        while (true) {
          const result = await iterator.next();
          if (result.done) {
            break;
          }

          const event = result.value as ProtocolEventMessage;

          for (const adapted of adapter.adapt(event)) {
            yield adapted as EventStreamEvent<
              StateType,
              UpdateType,
              CustomType
            >;
          }

          if (
            isTerminalLifecycleEvent(event) ||
            isInterruptedLifecycleEvent(event)
          ) {
            break;
          }
        }
      } finally {
        if (runtime.activeThread === thread) {
          runtime.activeThread = undefined;
        }
        signal.removeEventListener("abort", closeThread);
        await subscription.unsubscribe().catch(() => undefined);
        await thread.close().catch(() => undefined);
      }
    })(this);
  }

  async respond(args: { interruptId: string; response: unknown }) {
    const thread = this.activeThread;
    if (thread == null) {
      throw new Error("No active protocol thread is waiting for input.");
    }
    await thread.input.respond({
      namespace: ROOT_NAMESPACE,
      interrupt_id: args.interruptId,
      response: args.response,
    });
  }

  async join({
    threadId,
    runId,
    signal,
    lastEventId,
    streamMode,
  }: Parameters<
    StreamRuntime<StateType, UpdateType, ConfigurableType, CustomType>["join"]
  >[0]) {
    return this.client.runs.joinStream(threadId, runId, {
      signal,
      lastEventId,
      streamMode,
    });
  }
}
