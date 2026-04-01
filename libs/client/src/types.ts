import type {
  AgentResult,
  CapabilityAdvertisement,
  Channel,
  Event,
  InputInjectParams,
  InputRespondParams,
  ListCheckpointsParams,
  ListCheckpointsResult,
  ResourceDownloadParams,
  ResourceDownloadResult,
  ResourceListParams,
  ResourceListResult,
  ResourceReadParams,
  ResourceReadResult,
  ResourceWriteParams,
  RunInputParams,
  RunResult,
  SandboxInputParams,
  SandboxKillParams,
  StateForkParams,
  StateForkResult,
  StateGetParams,
  StateGetResult,
  StorePutParams,
  StoreSearchParams,
  StoreSearchResult,
  SubscribeParams,
  TransportProfile,
  UsageBudgetParams,
} from "@langchain/protocol";

import type { AssembledMessage } from "./messages.js";
import type { TransportAdapter } from "./transport.js";

export type SubscribeOptions = Omit<SubscribeParams, "channels">;

export type EventMethodByChannel = {
  values: "values";
  updates: "updates";
  messages: "messages";
  tools: "tools";
  custom: "custom";
  lifecycle: "lifecycle";
  media: "media.streamStart" | "media.streamEnd" | "media.artifact";
  resource: "resource.changed";
  sandbox: "sandbox.started" | "sandbox.output" | "sandbox.exited";
  input: "input.requested";
  state: "state.updated" | "state.storeChanged";
  usage: "usage.llmCall" | "usage.summary";
  debug: "debug";
  checkpoints: "checkpoints";
  tasks: "tasks";
};

export type EventForChannel<TChannel extends Channel> = Extract<
  Event,
  { method: EventMethodByChannel[TChannel] }
>;

export type EventForChannels<TChannels extends readonly Channel[]> =
  EventForChannel<TChannels[number]>;

/**
 * Optional client-level configuration applied to each opened session.
 */
export interface ProtocolClientOptions {
  /**
   * Maximum number of recent events retained for subscription replay.
   */
  eventBufferSize?: number;
  /**
   * Initial command id used when issuing protocol commands.
   */
  startingCommandId?: number;
}

/**
 * Tracks the most recent ordering metadata observed by the client.
 */
export interface SessionOrderingState {
  lastSeenSeq?: number;
  lastAppliedThroughSeq?: number;
  lastEventId?: string;
}

/**
 * Async iterable handle returned for raw protocol event subscriptions.
 */
export interface EventSubscription<
  TEvent extends Event = Event,
> extends AsyncIterable<TEvent> {
  readonly subscriptionId: string;
  readonly params: SubscribeParams;
  /**
   * Cancels the remote subscription and stops local iteration.
   */
  unsubscribe(): Promise<void>;
}

/**
 * Async iterable handle returned for assembled message subscriptions.
 */
export interface MessageSubscription extends AsyncIterable<AssembledMessage> {
  readonly subscriptionId: string;
  readonly params: SubscribeParams;
  /**
   * Cancels the underlying subscription and stops local iteration.
   */
  unsubscribe(): Promise<void>;
}

/**
 * Capability-gated modules surfaced by a session instance.
 */
export interface ResourceModule {
  /**
   * Lists resources available within a namespace.
   *
   * @param params - Resource list request parameters.
   */
  list(params: ResourceListParams): Promise<ResourceListResult>;
  /**
   * Reads a resource from a namespace.
   *
   * @param params - Resource read request parameters.
   */
  read(params: ResourceReadParams): Promise<ResourceReadResult>;
  /**
   * Writes text content to a resource path.
   *
   * @param params - Resource write request parameters.
   */
  write(params: ResourceWriteParams): Promise<void>;
  /**
   * Starts a resource download request.
   *
   * @param params - Resource download request parameters.
   */
  download(params: ResourceDownloadParams): Promise<ResourceDownloadResult>;
}

export interface SandboxModule {
  /**
   * Sends stdin input to a sandbox terminal.
   *
   * @param params - Sandbox input request parameters.
   */
  input(params: SandboxInputParams): Promise<void>;
  /**
   * Terminates a sandbox terminal process.
   *
   * @param params - Sandbox kill request parameters.
   */
  kill(params: SandboxKillParams): Promise<void>;
}

export interface InputModule {
  /**
   * Responds to an `input.requested` interrupt.
   *
   * @param params - Interrupt response payload.
   */
  respond(params: InputRespondParams): Promise<void>;
  /**
   * Injects an input message into the running session.
   *
   * @param params - Input injection payload.
   */
  inject(params: InputInjectParams): Promise<void>;
}

export interface StateModule {
  /**
   * Reads state values for a namespace.
   *
   * @param params - State lookup request parameters.
   */
  get(params: StateGetParams): Promise<StateGetResult>;
  /**
   * Searches the backing store namespace.
   *
   * @param params - Store search request parameters.
   */
  storeSearch(params: StoreSearchParams): Promise<StoreSearchResult>;
  /**
   * Writes a record into the backing store namespace.
   *
   * @param params - Store write request parameters.
   */
  storePut(params: StorePutParams): Promise<void>;
  /**
   * Lists checkpoints for a namespace.
   *
   * @param params - Checkpoint list request parameters.
   */
  listCheckpoints(
    params: ListCheckpointsParams
  ): Promise<ListCheckpointsResult>;
  /**
   * Forks a run from a checkpoint.
   *
   * @param params - Fork request parameters.
   */
  fork(params: StateForkParams): Promise<StateForkResult>;
}

export interface SessionModules {
  run: {
    /**
     * Sends input into the active run.
     *
     * @param params - Input payload forwarded to the active run.
     */
    input(params: RunInputParams): Promise<RunResult>;
  };
  agent: {
    /**
     * Retrieves the agent tree for a run.
     *
     * @param params - Optional run selector for the requested tree.
     */
    getTree(params?: { runId?: string }): Promise<AgentResult>;
  };
  resource?: ResourceModule;
  sandbox?: SandboxModule;
  input?: InputModule;
  state?: StateModule;
  usage?: {
    /**
     * Applies usage budget limits to the session.
     *
     * @param params - Budget configuration to apply.
     */
    setBudget(params: UsageBudgetParams): Promise<void>;
  };
}

/**
 * Low-level result of opening a session when both transport and metadata are
 * needed by the caller.
 */
export interface ClientOpenResult {
  sessionId: string;
  capabilities: CapabilityAdvertisement;
  transport: TransportProfile;
  adapter: TransportAdapter;
}
