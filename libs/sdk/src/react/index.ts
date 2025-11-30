export { useStream } from "./stream.js";
export { FetchStreamTransport } from "./stream.custom.js";
export type {
  UseStream,
  UseStreamCustom,
  UseStreamCustomOptions,
} from "./types.js";
export type {
  MessageMetadata,
  UseStreamOptions,
  UseStreamTransport,
  UseStreamThread,
  GetToolCallsType,
  // Agent type extraction helpers
  AgentTypeConfigLike,
  AgentToBag,
  IsAgentLike,
  ExtractAgentConfig,
  InferAgentToolCalls,
} from "../ui/types.js";
export type {
  ToolCallWithResult,
  DefaultToolCall,
  ToolCallFromTool,
  ToolCallsFromTools,
} from "../types.messages.js";
