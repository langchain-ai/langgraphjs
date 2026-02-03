export { useStream } from "./stream.js";
export { FetchStreamTransport } from "./stream.custom.js";
// Legacy exports - kept for backward compatibility
export type { UseStream, UseStreamCustom, SubagentStream } from "./types.js";
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
} from "../ui/stream/index.js";
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
} from "../ui/types.js";
export type {
  ToolCallWithResult,
  ToolCallState,
  DefaultToolCall,
  ToolCallFromTool,
  ToolCallsFromTools,
} from "../types.messages.js";
export {
  SubagentManager,
  extractToolCallIdFromNamespace,
  calculateDepthFromNamespace,
  extractParentIdFromNamespace,
  isSubagentNamespace,
} from "../ui/subagents.js";
