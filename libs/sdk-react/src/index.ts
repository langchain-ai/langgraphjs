import type {
  ToolMessage as CoreToolMessage,
  AIMessage as CoreAIMessage,
} from "@langchain/core/messages";
import type {
  ToolCallWithResult as _ToolCallWithResult,
  DefaultToolCall,
} from "@langchain/langgraph-sdk";

export {
  useStream,
  STREAM_CONTROLLER,
  type AnyStream,
  type UseStreamResult,
  type UseStreamReturn,
  type UseStreamOptions,
  type AgentServerOptions,
  type CustomAdapterOptions,
} from "./use-stream.js";

export { useProjection } from "./use-projection.js";

export {
  useMessages,
  useToolCalls,
  useValues,
  useExtension,
  useChannel,
  useAudio,
  useImages,
  useVideo,
  useFiles,
  useMessageMetadata,
  useSubmissionQueue,
} from "./selectors.js";
export type {
  SelectorTarget,
  UseSubmissionQueueReturn,
  SubmissionQueueEntry,
  SubmissionQueueSnapshot,
} from "./selectors.js";

export { useMediaURL } from "./use-media-url.js";
export {
  useAudioPlayer,
  type AudioPlayerHandle,
  type PlayerStatus,
  type UseAudioPlayerOptions,
} from "./use-audio-player.js";
export {
  useVideoPlayer,
  type UseVideoPlayerOptions,
  type VideoPlayerHandle,
} from "./use-video-player.js";

// Framework-agnostic types users reach for on the React side.
export type {
  AnyMediaHandle,
  AssembledToolCall,
  AudioMedia,
  Channel,
  Event,
  FileMedia,
  ImageMedia,
  MediaAssemblyErrorKind,
  MediaBase,
  MediaBlockType,
  SubagentDiscoverySnapshot,
  SubgraphDiscoverySnapshot,
  StreamSubmitOptions,
  ToolCallStatus,
  VideoMedia,
  MessageMetadata,
  MessageMetadataMap,
} from "@langchain/langgraph-sdk/stream";
export { MediaAssemblyError } from "@langchain/langgraph-sdk/stream";

// v1 type-inference helpers from the framework-agnostic stream module.
// `InferStateType` / `InferToolCalls` / `InferSubagentStates` /
// `WidenUpdateMessages` are the canonical names users reach for when
// prop-drilling a stream handle across components (plan-types.md §4, §8).
export type {
  InferStateType,
  InferToolCalls,
  InferSubagentStates,
  WidenUpdateMessages,
  AgentServerAdapter,
} from "@langchain/langgraph-sdk/stream";
export { HttpAgentServerAdapter } from "@langchain/langgraph-sdk";
export type { HttpAgentServerAdapterOptions } from "@langchain/langgraph-sdk";
export { useSuspenseStream } from "./suspense-stream.js";
export type { UseSuspenseStreamReturn } from "./suspense-stream.js";
export { StreamProvider, useStreamContext } from "./context.js";
export type {
  StreamProviderProps,
  StreamProviderCustomProps,
} from "./context.js";

export type ToolCallWithResult<ToolCall = DefaultToolCall> =
  _ToolCallWithResult<ToolCall, CoreToolMessage, CoreAIMessage>;
export type {
  ToolCallState,
  DefaultToolCall,
  ToolCallFromTool,
  ToolCallsFromTools,
} from "@langchain/langgraph-sdk";
export type {
  HeadlessToolImplementation,
  AnyHeadlessToolImplementation,
  ToolEvent,
  HeadlessToolInterrupt,
  OnToolCallback,
  FlushPendingHeadlessToolInterruptsOptions,
} from "@langchain/langgraph-sdk";
export {
  isHeadlessToolInterrupt,
  parseHeadlessToolInterruptPayload,
  filterOutHeadlessToolInterrupts,
  findHeadlessTool,
  executeHeadlessTool,
  handleHeadlessToolInterrupt,
  headlessToolResumeCommand,
  flushPendingHeadlessToolInterrupts,
} from "@langchain/langgraph-sdk";
