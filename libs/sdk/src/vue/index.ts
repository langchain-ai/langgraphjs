/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */
export { useStream } from "./stream.js";
export { FetchStreamTransport } from "../stream.transport.js";
export type { UseStream, UseStreamCustom } from "./types.js";
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
} from "../ui/types.js";
export type {
  ToolCallWithResult,
  ToolCallState,
  DefaultToolCall,
  ToolCallFromTool,
  ToolCallsFromTools,
} from "../types.messages.js";
