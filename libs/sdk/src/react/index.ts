export { useStream } from "./stream.js";
export { FetchStreamTransport } from "./stream.custom.js";
// Legacy exports - kept for backward compatibility
export type {
  UseStream,
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
export type {
  HeadlessToolImplementation,
  AnyHeadlessToolImplementation,
  ToolEvent,
  HeadlessToolInterrupt,
  OnToolCallback,
  FlushPendingHeadlessToolInterruptsOptions,
} from "../headless-tools.js";
export {
  SubagentManager,
  extractToolCallIdFromNamespace,
  calculateDepthFromNamespace,
  extractParentIdFromNamespace,
  isSubagentNamespace,
} from "../ui/subagents.js";
export {
  isHeadlessToolInterrupt,
  parseHeadlessToolInterruptPayload,
  filterOutHeadlessToolInterrupts,
  findHeadlessTool,
  executeHeadlessTool,
  handleHeadlessToolInterrupt,
  headlessToolResumeCommand,
  flushPendingHeadlessToolInterrupts,
} from "../headless-tools.js";

// MCP Apps (SEP-1865). `experimental_` because the extension is young and
// this surface will move with it. Needs `@modelcontextprotocol/ext-apps`,
// an optional peer: a host that renders no apps installs nothing extra.
export {
  MCPApp as experimental_MCPApp,
  MCPAppRenderer as experimental_MCPAppRenderer,
} from "./mcp-apps/MCPApp.js";
export type {
  MCPAppProps,
  MCPAppRendererProps,
  McpAppConfig,
  McpAppHandlers,
} from "./mcp-apps/MCPApp.js";
export { useMCPApps as experimental_useMCPApps } from "./mcp-apps/useMCPApps.js";
export type { MCPApps } from "./mcp-apps/useMCPApps.js";
export type {
  McpAppPart,
  McpAppResource,
  McpAppUri,
} from "../ui/mcp-apps/bindings.js";
