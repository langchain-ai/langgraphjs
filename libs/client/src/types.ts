import type {
  AgentResult,
  CapabilityAdvertisement,
  Event,
  InputInjectParams,
  InputRespondParams,
  ListCheckpointsParams,
  ListCheckpointsResult,
  ReconnectResult,
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

export interface ProtocolClientOptions {
  eventBufferSize?: number;
  startingCommandId?: number;
}

export interface SessionOrderingState {
  lastSeenSeq?: number;
  lastAppliedThroughSeq?: number;
  lastEventId?: string;
}

export interface EventSubscription<TEvent extends Event = Event>
  extends AsyncIterable<TEvent> {
  readonly subscriptionId: string;
  readonly params: SubscribeParams;
  unsubscribe(): Promise<void>;
}

export interface MessageSubscription extends AsyncIterable<AssembledMessage> {
  readonly subscriptionId: string;
  readonly params: SubscribeParams;
  unsubscribe(): Promise<void>;
}

export interface SessionModules {
  run: {
    input(params: RunInputParams): Promise<RunResult>;
  };
  agent: {
    getTree(params?: { runId?: string }): Promise<AgentResult>;
  };
  resource?: {
    list(params: ResourceListParams): Promise<ResourceListResult>;
    read(params: ResourceReadParams): Promise<ResourceReadResult>;
    write(params: ResourceWriteParams): Promise<void>;
    download(params: ResourceDownloadParams): Promise<ResourceDownloadResult>;
  };
  sandbox?: {
    input(params: SandboxInputParams): Promise<void>;
    kill(params: SandboxKillParams): Promise<void>;
  };
  input?: {
    respond(params: InputRespondParams): Promise<void>;
    inject(params: InputInjectParams): Promise<void>;
  };
  state?: {
    get(params: StateGetParams): Promise<StateGetResult>;
    storeSearch(params: StoreSearchParams): Promise<StoreSearchResult>;
    storePut(params: StorePutParams): Promise<void>;
    listCheckpoints(params: ListCheckpointsParams): Promise<ListCheckpointsResult>;
    fork(params: StateForkParams): Promise<StateForkResult>;
  };
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

