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
  type StreamThread,
  type UseStreamResult,
  type UseStreamReturn,
} from "./use-stream.js";

export {
  useMessages,
  useToolCalls,
  useValues,
  useChannel,
  useChannelEffect,
  useMessageMetadata,
  useSubmissionQueue,
  type UseChannelOptions,
  type UseChannelEffectOptions,
  type UseSubmissionQueueReturn,
} from "./selectors.js";

export { type SelectorTarget, type StreamLike } from "./use-scoped.js";

export {
  useSuspenseStream,
  type UseSuspenseStreamReturn,
} from "./suspense-stream.js";

export {
  StreamProvider,
  useStreamContext,
  type StreamProviderCustomProps,
  type StreamProviderProps,
} from "./context.js";

export type {
  AgentServerOptions,
  Channel,
  CustomTransportOptions,
  Event,
  MessageMetadata,
  MessageMetadataMap,
  RunCompletedInfo,
  RunExecutionInfo,
  RunExecutionReason,
  StreamRespondAllOptions,
  StreamRespondOptions,
  StreamStopOptions,
  StreamSubmitOptions,
  SubagentDiscoverySnapshot,
  SubmissionQueueEntry,
  SubmissionQueueSnapshot,
  UseStreamCommonOptions,
  UseStreamOptions,
} from "./types.js";

export type {
  AcceptBaseMessages as WidenUpdateMessages,
  AssembledToolCall,
  AssembledToolCallFromTool as ToolCallFromTool,
  InferAssembledToolCalls as InferToolCalls,
  InferStateType,
  InferSubagentStates,
  SubgraphDiscoverySnapshot,
  ToolCallStatus,
} from "@langchain/langgraph-sdk/ui";

export type ToolCallWithResult<ToolCall = DefaultToolCall> =
  _ToolCallWithResult<ToolCall, CoreToolMessage, CoreAIMessage>;
export type {
  ToolCallState,
  DefaultToolCall,
  ToolCallsFromTools,
  InferToolOutput,
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
  applyHeadlessToolResumeCommand,
  flushPendingHeadlessToolInterrupts,
} from "@langchain/langgraph-sdk";
