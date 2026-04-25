import type {
  AgentStatus,
  MessageMetadata,
  Namespace,
  ProtocolEventByMethod,
  SupportedChannel,
  UpdatesEvent,
} from "../types.mjs";

/**
 * Scalar metadata values that can be forwarded directly in protocol events.
 */
export type ProtocolMetadataScalar = string | number | boolean | null;

/**
 * Concise message metadata shape exposed to protocol clients.
 */
export type ProtocolCompatibleMessageMetadata = MessageMetadata &
  Record<string, ProtocolMetadataScalar>;

/**
 * Subscription state tracked for each connected client.
 */
export type SubscriptionChannel = SupportedChannel | `custom:${string}`;

export type Subscription = {
  id: string;
  channels: Set<SubscriptionChannel>;
  namespaces?: Namespace[];
  depth?: number;
  active: boolean;
};

/**
 * Cached lifecycle information for a namespace in the agent tree.
 */
export type NamespaceInfo = {
  namespace: Namespace;
  status: AgentStatus;
  graphName: string;
};

/**
 * Normalized representation of an updates payload emitted by the run stream.
 */
export type NormalizedUpdatesData = {
  node?: string;
  values: UpdatesEvent["params"]["data"]["values"];
};

/**
 * Mapping between supported event methods and their payload shapes.
 */
export type ProtocolEventDataMap = {
  values: ProtocolEventByMethod<"values">["params"]["data"];
  updates:
    | ProtocolEventByMethod<"updates">["params"]["data"]
    | UpdatesEvent["params"]["data"]["values"];
  checkpoints: ProtocolEventByMethod<"checkpoints">["params"]["data"];
  messages: ProtocolEventByMethod<"messages">["params"]["data"];
  tools: ProtocolEventByMethod<"tools">["params"]["data"];
  custom: ProtocolEventByMethod<"custom">["params"]["data"];
  lifecycle: ProtocolEventByMethod<"lifecycle">["params"]["data"];
  input: ProtocolEventByMethod<"input">["params"]["data"];
  tasks: ProtocolEventByMethod<"tasks">["params"]["data"];
};

/**
 * Channel names supported by the run-scoped protocol session.
 */
export const SUPPORTED_CHANNELS = new Set<SupportedChannel>([
  "values",
  "updates",
  "checkpoints",
  "messages",
  "tools",
  "custom",
  "lifecycle",
  "input",
  "tasks",
]);

/**
 * Checks whether a value is a non-null object record.
 *
 * @param value - Candidate value to inspect.
 * @returns Whether the value can be treated as a keyed object.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Checks whether a channel name is supported by the session transport.
 *
 * @param value - Raw channel name.
 * @returns Whether the name matches a supported protocol channel.
 */
export const isSupportedChannel = (value: string): value is SupportedChannel =>
  SUPPORTED_CHANNELS.has(value as SupportedChannel);
