import { DefaultValues } from "../schema.js";
import { type ClientConfig } from "./base.js";
import { AssistantsClient } from "./assistants/index.js";
import { ThreadsClient } from "./threads/index.js";
import { RunsClient } from "./runs/index.js";
import { CronsClient } from "./crons/index.js";
import { StoreClient } from "./store/index.js";
import { UiClient } from "./ui-internal/index.js";

export class Client<
  TStateType = DefaultValues,
  TUpdateType = TStateType,
  TCustomEventType = unknown,
> {
  /**
   * The client for interacting with assistants.
   */
  public assistants: AssistantsClient;

  /**
   * The client for interacting with threads.
   */
  public threads: ThreadsClient<TStateType, TUpdateType>;

  /**
   * The client for interacting with runs.
   */
  public runs: RunsClient<TStateType, TUpdateType, TCustomEventType>;

  /**
   * The client for interacting with cron runs.
   */
  public crons: CronsClient;

  /**
   * The client for interacting with the KV store.
   */
  public store: StoreClient;

  /**
   * The client for interacting with the UI.
   * @internal Used by LoadExternalComponent and the API might change in the future.
   */
  public "~ui": UiClient;

  /**
   * @internal Used to obtain a stable key representing the client.
   */
  private "~configHash": string | undefined;

  constructor(config?: ClientConfig) {
    this["~configHash"] = (() =>
      JSON.stringify({
        apiUrl: config?.apiUrl,
        apiKey: config?.apiKey,
        timeoutMs: config?.timeoutMs,
        defaultHeaders: config?.defaultHeaders,
        streamProtocol: config?.streamProtocol,

        maxConcurrency: config?.callerOptions?.maxConcurrency,
        maxRetries: config?.callerOptions?.maxRetries,

        callbacks: {
          onFailedResponseHook:
            config?.callerOptions?.onFailedResponseHook != null,
          onRequest: config?.onRequest != null,
          fetch: config?.callerOptions?.fetch != null,
        },
      }))();

    this.assistants = new AssistantsClient(config);
    this.threads = new ThreadsClient(config);
    this.runs = new RunsClient(config);
    this.crons = new CronsClient(config);
    this.store = new StoreClient(config);
    this["~ui"] = new UiClient(config);
  }
}

/**
 * @internal Used to obtain a stable key representing the client.
 */
export function getClientConfigHash(client: Client): string | undefined {
  return client["~configHash"];
}

export { BaseClient } from "./base.js";
export { getApiKey } from "./base.js";
export type { ClientConfig, RequestHook, HeaderValue } from "./base.js";
export { AssistantsClient } from "./assistants/index.js";
export { ThreadsClient } from "./threads/index.js";
export { RunsClient } from "./runs/index.js";
export { CronsClient } from "./crons/index.js";
export { StoreClient } from "./store/index.js";

export {
  ProtocolError,
  ThreadStream,
  SubscriptionHandle,
  StreamingMessage,
  StreamingMessageAssembler,
  MessageAssembler,
  MediaAssembler,
  MediaAssemblyError,
  ToolCallAssembler,
  SubgraphDiscoveryHandle,
  SubgraphHandle,
  SubagentHandle,
  SubagentDiscoveryHandle,
  inferChannel,
  matchesSubscription,
} from "./stream/index.js";

export type {
  TransportAdapter,
  AgentServerAdapter,
  AssembledMessage,
  MessageAssemblyUpdate,
  AssembledToolCall,
  ToolCallStatus,
  Subscribable,
  InterruptPayload,
  SubscribeOptions,
  EventMethodByChannel,
  EventForChannel,
  EventForChannels,
  ThreadStreamOptions,
  ThreadStreamTransport,
  ThreadStreamTransportKind,
  SessionOrderingState,
  EventSubscription,
  MessageSubscription,
  InputModule,
  StateModule,
  ThreadModules,
  ThreadExtension,
  ThreadExtensions,
  UnwrapExtension,
  AnyMediaHandle,
  AudioMedia,
  FileMedia,
  ImageMedia,
  MediaAssemblerCallbacks,
  MediaAssemblerOptions,
  MediaAssemblyErrorKind,
  MediaBase,
  MediaBlockType,
  VideoMedia,
} from "./stream/index.js";

export {
  ProtocolSseTransportAdapter,
  ProtocolWebSocketTransportAdapter,
  HttpAgentServerAdapter,
} from "./stream/transport/index.js";

export type { HttpAgentServerAdapterOptions } from "./stream/transport/index.js";

export type {
  ProtocolRequestHook,
  ProtocolSseTransportOptions,
  ProtocolWebSocketTransportOptions,
  ProtocolTransportPaths,
  ProtocolHeaderValue,
} from "./stream/transport/index.js";
