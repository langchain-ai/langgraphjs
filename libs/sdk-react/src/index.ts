import type {
  ToolMessage as CoreToolMessage,
  AIMessage as CoreAIMessage,
} from "@langchain/core/messages";
import type {
  ToolCallWithResult as _ToolCallWithResult,
  DefaultToolCall,
} from "@langchain/langgraph-sdk";

export { useStream, type ClassSubagentStreamInterface } from "./stream.js";
export {
  useSuspenseStream,
  createSuspenseCache,
  invalidateSuspenseCache,
} from "./suspense-stream.js";
export type { SuspenseCache } from "./suspense-stream.js";
export { FetchStreamTransport } from "./stream.custom.js";
export { StreamProvider, useStreamContext } from "./context.js";
export type {
  StreamProviderProps,
  StreamProviderCustomProps,
} from "./context.js";
// Legacy exports - kept for backward compatibility
export type {
  UseStream,
  UseSuspenseStream,
  UseStreamCustom,
  SubagentStream,
  SubagentStreamInterface,
} from "./types.js";
// New stream interface types
export type {
  // Base stream types
  BaseStream,
  // Agent stream types (for createAgent)
  UseAgentStream,
  UseAgentStreamOptions,
  // DeepAgent stream types (for createDeepAgent)
  UseDeepAgentStream,
  UseDeepAgentStreamOptions,
  // Type resolvers
  ResolveStreamInterface,
  ResolveStreamOptions,
  InferStateType,
  InferToolCalls,
  InferSubagentStates,
  InferNodeNames,
  InferBag,
} from "@langchain/langgraph-sdk/ui";
export type {
  MessageMetadata,
  UseStreamOptions,
  UseStreamCustomOptions,
  UseStreamTransport,
  UseStreamThread,
  GetToolCallsType,
  // Agent type extraction helpers
  AgentTypeConfigLike,
  IsAgentLike,
  ExtractAgentConfig,
  InferAgentToolCalls,
  // Subagent types
  SubagentToolCall,
  SubagentStatus,
  // DeepAgent type helpers for subagent inference
  SubAgentLike,
  CompiledSubAgentLike,
  DeepAgentTypeConfigLike,
  IsDeepAgentLike,
  ExtractDeepAgentConfig,
  ExtractSubAgentMiddleware,
  InferDeepAgentSubagents,
  InferSubagentByName,
  InferSubagentState,
  InferSubagentNames,
  SubagentStateMap,
  DefaultSubagentStates,
  BaseSubagentState,
  QueueEntry,
  QueueInterface,
} from "@langchain/langgraph-sdk/ui";

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
  SubagentManager,
  extractToolCallIdFromNamespace,
  calculateDepthFromNamespace,
  extractParentIdFromNamespace,
  isSubagentNamespace,
} from "@langchain/langgraph-sdk/ui";
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
