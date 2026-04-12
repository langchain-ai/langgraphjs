import { DefaultValues } from "../schema.js";
import { type ClientConfig, getApiKey, type HeaderValue } from "./base.js";
import { AssistantsClient } from "./assistants/index.js";
import { ThreadsClient } from "./threads/index.js";
import { RunsClient } from "./runs/index.js";
import { CronsClient } from "./crons/index.js";
import { StoreClient } from "./store/index.js";
import { UiClient } from "./ui-internal/index.js";
import { ProtocolClient } from "./stream/index.js";
import { ProtocolSseTransportAdapter } from "./stream/transport/http.js";

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
   * The client for interacting with the streaming protocol (v2).
   * Provides session-based streaming with subscriptions, message assembly,
   * and capability-gated modules over SSE or WebSocket transports.
   */
  public stream: ProtocolClient;

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

    const apiUrl =
      config?.apiUrl?.replace(/\/$/, "") || "http://localhost:8123";
    const apiKey = getApiKey(config?.apiKey);
    const defaultHeaders: Record<string, HeaderValue> = {
      ...config?.defaultHeaders,
    };
    if (apiKey) {
      defaultHeaders["x-api-key"] = apiKey;
    }

    this.stream = new ProtocolClient(
      () =>
        new ProtocolSseTransportAdapter({
          apiUrl,
          defaultHeaders,
          onRequest: config?.onRequest,
          fetch: config?.callerOptions?.fetch,
        })
    );
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
  ProtocolClient,
  ProtocolError,
  Session,
  SubscriptionHandle,
  MessageSubscriptionHandle,
  EventBuffer,
  MessageAssembler,
  inferChannel,
  matchesSubscription,
} from "./stream/index.js";

export type {
  TransportAdapter,
  AssembledMessage,
  MessageAssemblyUpdate,
  SubscribeOptions,
  SubscribableChannel,
  EventMethodByChannel,
  EventForChannel,
  EventForChannels,
  ProtocolClientOptions,
  SessionOrderingState,
  EventSubscription,
  MessageSubscription,
  ResourceModule,
  SandboxModule,
  InputModule,
  StateModule,
  SessionModules,
  ClientOpenResult,
} from "./stream/index.js";

export {
  ProtocolSseTransportAdapter,
  ProtocolWebSocketTransportAdapter,
} from "./stream/transport/index.js";

export type {
  ProtocolRequestHook,
  ProtocolSseTransportOptions,
  ProtocolWebSocketTransportOptions,
  ProtocolHeaderValue,
} from "./stream/transport/index.js";
