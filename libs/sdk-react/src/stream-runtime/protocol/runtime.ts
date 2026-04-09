import { ProtocolClient } from "@langchain/client";
import type { CapabilityAdvertisement, Channel } from "@langchain/protocol";
import type {
  Client,
  StreamMode,
  StreamProtocol,
} from "@langchain/langgraph-sdk";
import type { RequestHook } from "@langchain/langgraph-sdk/client";
import type { EventStreamEvent } from "@langchain/langgraph-sdk/ui";
import {
  ProtocolEventAdapter,
  canUseProtocolSse,
  getProtocolChannels,
  type ProtocolEventMessage,
} from "@langchain/langgraph-sdk/utils";
import type { StreamRuntime } from "../types.js";
import { ProtocolSseTransportAdapter } from "./http-transport.js";
import { ProtocolWebSocketTransportAdapter } from "./websocket-transport.js";

type HeaderValue = string | undefined | null;

type RunsClientInternals = {
  apiUrl?: string;
  defaultHeaders?: Record<string, HeaderValue>;
  onRequest?: RequestHook;
  asyncCaller?: {
    fetch: typeof fetch;
  };
};

type SessionOpenParams = Parameters<ProtocolClient["open"]>[0];

type ProtocolTransportMode = "sse-http" | "websocket";

type ProtocolRuntimeConfig = ReturnType<typeof getProtocolConfig> & {
  webSocketFactory?: (url: string) => WebSocket;
};

const ROOT_NAMESPACE: string[] = [];
const PROTOCOL_COMMAND_MODULES: CapabilityAdvertisement["modules"] = [
  {
    name: "session",
    commands: ["open", "describe", "close"],
  },
  {
    name: "subscription",
    commands: ["subscribe", "unsubscribe", "reconnect"],
  },
  {
    name: "run",
    commands: ["input"],
  },
];

const PROTOCOL_CHANNEL_MODULE_NAME: Partial<Record<Channel, string>> = {
  lifecycle: "agent",
};

const isTerminalLifecycleEvent = (event: ProtocolEventMessage): boolean => {
  if (event.method !== "lifecycle") {
    return false;
  }

  if (event.params.namespace.length !== ROOT_NAMESPACE.length) {
    return false;
  }

  const data = event.params.data as { event?: unknown };
  return (
    data?.event === "completed" ||
    data?.event === "failed" ||
    data?.event === "interrupted"
  );
};

const isResumeOnlyCommand = (command: unknown): command is { resume: unknown } =>
  typeof command === "object" &&
  command !== null &&
  "resume" in command &&
  !("update" in command) &&
  !("goto" in command);

function getProtocolConfig(
  client: Client,
): {
  apiUrl: string;
  defaultHeaders?: Record<string, HeaderValue>;
  onRequest?: RequestHook;
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
  streamProtocol: StreamProtocol | undefined,
): ProtocolTransportMode {
  return streamProtocol === "v2-websocket" ? "websocket" : "sse-http";
}

function getProtocolCapabilities(
  streamMode?: StreamMode | StreamMode[],
): CapabilityAdvertisement {
  return {
    modules: [
      ...PROTOCOL_COMMAND_MODULES,
      ...getProtocolChannels(streamMode).map((channel) => ({
        name: PROTOCOL_CHANNEL_MODULE_NAME[channel] ?? channel,
        channels: [channel],
      })),
    ],
  };
}

export class ProtocolStreamRuntime<
  StateType extends Record<string, unknown>,
  UpdateType,
  ConfigurableType extends Record<string, unknown>,
  CustomType,
> implements StreamRuntime<StateType, UpdateType, ConfigurableType, CustomType>
{
  private readonly transportConfig: ProtocolRuntimeConfig;
  private readonly protocolTransport: ProtocolTransportMode;

  constructor(
    private readonly client: Client<StateType, UpdateType, CustomType>,
    streamProtocol: StreamProtocol | undefined,
    options?: {
      protocolFetch?: typeof fetch;
      protocolWebSocket?: (url: string) => WebSocket;
    },
  ) {
    this.protocolTransport = getProtocolTransportMode(streamProtocol);
    const transportConfig = getProtocolConfig(client);
    this.transportConfig = {
      ...transportConfig,
      fetch: options?.protocolFetch ?? transportConfig.fetch,
      webSocketFactory: options?.protocolWebSocket,
    };
  }

  canSubmit({
    streamMode,
    submitOptions,
  }: {
    streamMode: StreamMode[];
    submitOptions?: {
      context?: unknown;
      checkpoint?: unknown;
      interruptBefore?: unknown;
      interruptAfter?: unknown;
      multitaskStrategy?: unknown;
      onCompletion?: unknown;
      onDisconnect?: unknown;
      durability?: unknown;
      command?: unknown;
    };
  }): boolean {
    if (!canUseProtocolSse(streamMode)) {
      return false;
    }

    if (
      submitOptions?.context != null ||
      submitOptions?.checkpoint != null ||
      submitOptions?.interruptBefore != null ||
      submitOptions?.interruptAfter != null ||
      submitOptions?.multitaskStrategy != null ||
      submitOptions?.onCompletion != null ||
      submitOptions?.durability != null
    ) {
      return false;
    }

    if (
      submitOptions?.command != null &&
      !isResumeOnlyCommand(submitOptions.command)
    ) {
      return false;
    }

    return true;
  }

  async submit({
    assistantId,
    threadId,
    input,
    submitOptions,
    signal,
    streamMode,
    onRunCreated,
  }: Parameters<StreamRuntime<
    StateType,
    UpdateType,
    ConfigurableType,
    CustomType
  >["submit"]>[0]): Promise<
    AsyncGenerator<EventStreamEvent<StateType, UpdateType, CustomType>>
  > {
    const protocolClient = new ProtocolClient(
      () =>
        this.protocolTransport === "websocket"
          ? new ProtocolWebSocketTransportAdapter(this.transportConfig)
          : new ProtocolSseTransportAdapter(this.transportConfig),
    );
    const sessionParams: SessionOpenParams = {
      protocolVersion: "0.3.0",
      target: {
        kind: "agent",
        id: assistantId,
      },
      capabilities: getProtocolCapabilities(streamMode),
      preferredTransports: [this.protocolTransport],
    };
    const session = await protocolClient.open(sessionParams);

    const subscription = await session.subscribe({
      channels: getProtocolChannels(streamMode),
    });

    const runInput =
      submitOptions?.command != null && isResumeOnlyCommand(submitOptions.command)
        ? submitOptions.command.resume
        : input;

    const metadata =
      submitOptions?.metadata != null && typeof submitOptions.metadata === "object"
        ? (submitOptions.metadata as Record<string, unknown>)
        : undefined;

    const runResult = await session.run.input({
      input: runInput ?? null,
      config: submitOptions?.config,
      metadata,
    });

    const runId = runResult.runId;
    if (typeof runId !== "string" || runId.length === 0) {
      await session.close().catch(() => undefined);
      throw new Error("Protocol run did not return a run ID.");
    }

    onRunCreated?.({
      run_id: runId,
      thread_id: threadId,
    });

    const closeSession = () => {
      void session.close().catch(() => undefined);
    };
    signal.addEventListener("abort", closeSession, { once: true });

    return (async function* (): AsyncGenerator<
      EventStreamEvent<StateType, UpdateType, CustomType>
    > {
      const adapter = new ProtocolEventAdapter();
      try {
        yield {
          event: "metadata",
          data: {
            run_id: runId,
            thread_id: threadId,
          },
        } as EventStreamEvent<StateType, UpdateType, CustomType>;

        for await (const event of subscription) {
          for (const adapted of adapter.adapt(event as ProtocolEventMessage)) {
            yield adapted as EventStreamEvent<
              StateType,
              UpdateType,
              CustomType
            >;
          }

          if (isTerminalLifecycleEvent(event as ProtocolEventMessage)) {
            break;
          }
        }
      } finally {
        signal.removeEventListener("abort", closeSession);
        await subscription.unsubscribe().catch(() => undefined);
        await session.close().catch(() => undefined);
      }
    })();
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
