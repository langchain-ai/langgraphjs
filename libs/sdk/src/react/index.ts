export { useStream } from "./stream.js";
export { FetchStreamTransport } from "./stream.custom.js";
export type { UseStream, UseStreamCustom, SubagentStream } from "./types.js";
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
