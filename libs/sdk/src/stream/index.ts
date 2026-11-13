/**
 * Experimental v2-native stream runtime (framework-agnostic).
 *
 * This is the pure-TypeScript core every framework binding composes
 * over. It has zero framework imports so React, Vue, Svelte, and
 * Angular bindings can pick their own reactivity primitive and wrap
 * the `subscribe` / `getSnapshot` contract exposed by
 * {@link StreamStore}.
 *
 * Public surfaces:
 *   - {@link StreamController}  — thread lifecycle + imperatives
 *   - {@link ChannelRegistry}   — ref-counted subscription cache
 *   - {@link StreamStore}       — minimal observable primitive
 *   - `*Projection` factories   — per-kind {@link ProjectionSpec}s
 *   - `assembledToBaseMessage`  — `AssembledMessage` → `BaseMessage`
 *
 * See `libs/sdk-react/useStream.md` for the React binding
 * design and the intended migration path from `useStream`.
 */
export type {
  AgentTypeConfigLike,
  CompiledSubAgentLike,
  DefaultSubagentStates,
  DeepAgentTypeConfigLike,
  ExtractAgentConfig,
  ExtractDeepAgentConfig,
  ExtractSubAgentMiddleware,
  InferAgentToolCalls,
  InferDeepAgentSubagents,
  InferSubagentByName,
  InferSubagentNames,
  InferSubagentState,
  IsAgentLike,
  IsDeepAgentLike,
  SubAgentLike,
  SubagentStateMap,
  SubagentToolCall,
  AcceptBaseMessages as WidenUpdateMessages,
} from "../ui/types.js";
export type {
  InferBag,
  InferNodeNames,
  InferStateType,
  InferSubagentStates,
} from "../ui/stream/index.js";
export type {
  AssembledToolCallFromTool,
  InferAssembledToolCalls as InferToolCalls,
} from "../ui/types-inference.js";
export type {
  DefaultToolCall,
  InferToolOutput,
  ToolCallFromTool,
} from "../types.messages.js";

export { StreamStore } from "../ui/store.js";
export type { StoreListener } from "../ui/store.js";

export { ChannelRegistry } from "./channel-registry.js";

export { StreamController, ROOT_PUMP_CHANNELS } from "./controller.js";
export type {
  MessageMetadata,
  MessageMetadataMap,
  SubmissionQueueEntry,
  SubmissionQueueSnapshot,
} from "./controller.js";

export { SubagentDiscovery } from "./discovery/index.js";
export type { SubagentMap } from "./discovery/index.js";
export { SubgraphDiscovery } from "../ui/subgraphs.js";
export type {
  SubgraphByNodeMap,
  SubgraphDiscoverySnapshot,
  SubgraphMap,
} from "../ui/subgraphs.js";

export {
  messagesProjection,
  toolCallsProjection,
  valuesProjection,
  extensionProjection,
  channelProjection,
  acquireChannelEffect,
  audioProjection,
  imagesProjection,
  videoProjection,
  filesProjection,
} from "./projections/index.js";
export type {
  ChannelProjectionOptions,
  ChannelEffectOptions,
  MediaProjectionOptions,
} from "./projections/index.js";

export {
  assembledToBaseMessage,
  assembledMessageToBaseMessage,
} from "./assembled-to-message.js";
export type {
  AssembledToMessageInput,
  ExtendedMessageRole,
} from "./assembled-to-message.js";

export type {
  AcquiredProjection,
  AgentServerOptions,
  CustomAdapterOptions,
  ProjectionRuntime,
  ProjectionSpec,
  RootEventBus,
  RootSnapshot,
  RunCompletedInfo,
  RunExecutionInfo,
  RunExecutionReason,
  StreamControllerOptions,
  StreamRespondAllOptions,
  StreamRespondOptions,
  StreamStopOptions,
  StreamSubmitOptions,
  SubagentDiscoverySnapshot,
  Target,
  UseStreamCommonOptions,
  UseStreamOptions,
} from "./types.js";

// `AgentServerAdapter` / `TransportAdapter` live in the client-side
// transport module and flow into `ThreadStreamOptions["transport"]`;
// bindings that wire custom adapters reach for them from here.
export type {
  AgentServerAdapter,
  TransportAdapter,
} from "../client/stream/transport.js";

export { NAMESPACE_SEPARATOR, DEFAULT_MESSAGES_KEY } from "../ui/constants.js";

// Types framework bindings (React, Vue, Svelte, Angular) typically
// need when wrapping the projection factories. Re-exported here so
// bindings can reach them without a deep subpath import.
export type { AssembledToolCall, ToolCallStatus } from "../ui/tool-payload.js";
export { parseToolPayload, parseToolOutput } from "../ui/tool-payload.js";

export { MediaAssembler, MediaAssemblyError } from "../client/stream/media.js";

export { isUnknownInterruptError } from "./refusal.js";
export type { StrictResumeRefusal, UnknownInterruptError } from "./refusal.js";
export type {
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
} from "../client/stream/media.js";

// Protocol primitives that leak through the public surface (e.g.
// `useChannel` returns `Event[]` and accepts `Channel[]`). Re-exported
// here so application code doesn't need a direct dependency on
// `@langchain/protocol`.
export type { Channel, Event } from "@langchain/protocol";
