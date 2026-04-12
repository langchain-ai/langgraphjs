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
  SubscribeParams,
  TransportProfile,
  UsageBudgetParams,
} from "@langchain/protocol";

import type { AssembledMessage } from "./messages.js";
import type { TransportAdapter } from "./transport.js";

export type SubscribeOptions = Omit<SubscribeParams, "channels">;

/**
 * Extends the protocol `Channel` type with support for named custom
 * channels like `"custom:a2a"`, allowing fine-grained subscriptions.
 */
export type SubscribableChannel = Channel | `custom:${string}`;

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
  state: "state.updated";
  usage: "usage.llmCall" | "usage.summary";
  debug: "debug";
  checkpoints: "checkpoints";
  tasks: "tasks";
};

export type EventForChannel<TChannel extends SubscribableChannel> =
  TChannel extends Channel
    ? Extract<Event, { method: EventMethodByChannel[TChannel] }>
    : TChannel extends `custom:${string}`
      ? Extract<Event, { method: "custom" }>
      : never;

export type EventForChannels<TChannels extends readonly SubscribableChannel[]> =
  EventForChannel<TChannels[number]>;

/**
 * Maps a subscribable channel to the type yielded by its subscription handle.
 *
 * - `"custom:name"` channels yield `unknown` (the raw emitted payload).
 * - All other channels yield the full protocol `Event`.
 */
export type YieldForChannel<TChannel extends SubscribableChannel> =
  TChannel extends `custom:${string}` ? unknown : EventForChannel<TChannel>;

export type YieldForChannels<TChannels extends readonly SubscribableChannel[]> =
  YieldForChannel<TChannels[number]>;

export interface ProtocolClientOptions {
  eventBufferSize?: number;
  startingCommandId?: number;
}

export interface SessionOrderingState {
  lastSeenSeq?: number;
  lastAppliedThroughSeq?: number;
  lastEventId?: string;
}

export interface EventSubscription<
  TYield = Event,
> extends AsyncIterable<TYield> {
  readonly subscriptionId: string;
  readonly params: SubscribeParams;
  unsubscribe(): Promise<void>;
}

export interface MessageSubscription extends AsyncIterable<AssembledMessage> {
  readonly subscriptionId: string;
  readonly params: SubscribeParams;
  unsubscribe(): Promise<void>;
}

export interface ResourceModule {
  list(params: ResourceListParams): Promise<ResourceListResult>;
  read(params: ResourceReadParams): Promise<ResourceReadResult>;
  write(params: ResourceWriteParams): Promise<void>;
  download(params: ResourceDownloadParams): Promise<ResourceDownloadResult>;
}

export interface SandboxModule {
  input(params: SandboxInputParams): Promise<void>;
  kill(params: SandboxKillParams): Promise<void>;
}

export interface InputModule {
  respond(params: InputRespondParams): Promise<void>;
  inject(params: InputInjectParams): Promise<void>;
}

export interface StateModule {
  get(params: StateGetParams): Promise<StateGetResult>;
  listCheckpoints(
    params: ListCheckpointsParams
  ): Promise<ListCheckpointsResult>;
  fork(params: StateForkParams): Promise<StateForkResult>;
}

export interface SessionModules {
  run: {
    input(params: RunInputParams): Promise<RunResult>;
  };
  agent: {
    getTree(params?: { run_id?: string }): Promise<AgentResult>;
  };
  resource?: ResourceModule;
  sandbox?: SandboxModule;
  input?: InputModule;
  state?: StateModule;
  usage?: {
    setBudget(params: UsageBudgetParams): Promise<void>;
  };
}

export interface ClientOpenResult {
  sessionId: string;
  capabilities: CapabilityAdvertisement;
  transport: TransportProfile;
  adapter: TransportAdapter;
}
