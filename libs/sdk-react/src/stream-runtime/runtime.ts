import {
  ProtocolClient,
  ProtocolSseTransportAdapter,
  type ProtocolRequestHook,
  ProtocolWebSocketTransportAdapter,
} from "@langchain/client";
import type { CapabilityAdvertisement, Channel } from "@langchain/protocol";
import type {
  Client,
  StreamMode,
  StreamProtocol,
} from "@langchain/langgraph-sdk";
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

type SessionOpenParams = Parameters<ProtocolClient["open"]>[0];
type SessionOpenConfig = SessionOpenParams extends { config?: infer T }
  ? T
  : never;
type RunInputParams = Parameters<
  Awaited<ReturnType<ProtocolClient["open"]>>["run"]["input"]
>[0];
type RunInputConfig = RunInputParams extends { config?: infer T } ? T : never;

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
  {
    name: "input",
    commands: ["respond"],
    channels: ["input"],
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

function getProtocolCapabilities(
  streamMode?: StreamMode | StreamMode[]
): CapabilityAdvertisement {
  const modules = new Map<
    string,
    { name: string; commands?: string[]; channels?: Channel[] }
  >();

  const upsertModule = (module: {
    name: string;
    commands?: string[];
    channels?: Channel[];
  }) => {
    const existing = modules.get(module.name);
    if (!existing) {
      modules.set(module.name, {
        name: module.name,
        commands: module.commands ? [...module.commands] : undefined,
        channels: module.channels ? [...module.channels] : undefined,
      });
      return;
    }

    if (module.commands?.length) {
      existing.commands = [
        ...new Set([...(existing.commands ?? []), ...module.commands]),
      ];
    }
    if (module.channels?.length) {
      existing.channels = [
        ...new Set([...(existing.channels ?? []), ...module.channels]),
      ];
    }
  };

  for (const module of PROTOCOL_COMMAND_MODULES) {
    upsertModule(module);
  }
  for (const channel of getProtocolChannels(streamMode)) {
    upsertModule({
      name: PROTOCOL_CHANNEL_MODULE_NAME[channel] ?? channel,
      channels: [channel],
    });
  }

  return {
    modules: [...modules.values()],
  };
}

function bindThreadConfig(
  config: unknown,
  threadId: string
): SessionOpenConfig & RunInputConfig {
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
  } as SessionOpenConfig & RunInputConfig;
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
  private activeSession?: Awaited<ReturnType<ProtocolClient["open"]>>;

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
    const protocolClient = new ProtocolClient(() =>
      this.protocolTransport === "websocket"
        ? new ProtocolWebSocketTransportAdapter(this.transportConfig)
        : new ProtocolSseTransportAdapter(this.transportConfig)
    );
    const boundConfig = bindThreadConfig(submitOptions?.config, threadId);
    const sessionParams: SessionOpenParams = {
      protocolVersion: "0.3.0",
      target: {
        id: assistantId,
      },
      config: boundConfig,
      capabilities: getProtocolCapabilities(streamMode),
      preferredTransports: [this.protocolTransport],
    };
    const session = await protocolClient.open(sessionParams);
    this.activeSession = session;

    const subscription = await session.subscribe({
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

    const runResult = await session.run.input({
      input: runInput ?? null,
      config: boundConfig,
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
        if (runtime.activeSession === session) {
          runtime.activeSession = undefined;
        }
        signal.removeEventListener("abort", closeSession);
        await subscription.unsubscribe().catch(() => undefined);
        await session.close().catch(() => undefined);
      }
    })(this);
  }

  async respond(args: { interruptId: string; response: unknown }) {
    const session = this.activeSession;
    if (session?.input == null) {
      throw new Error("No active protocol session is waiting for input.");
    }
    await session.input.respond({
      namespace: ROOT_NAMESPACE,
      interruptId: args.interruptId,
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
