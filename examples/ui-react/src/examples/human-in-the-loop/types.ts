import type { ToolCallFromTool } from "@langchain/langgraph-sdk/react";

import type { sendEmail, deleteFile, readFile } from "./agent";

/**
 * Type for tool calls from our agent
 */
export type AgentToolCalls =
  | ToolCallFromTool<typeof sendEmail>
  | ToolCallFromTool<typeof deleteFile>
  | ToolCallFromTool<typeof readFile>;
