import {
  useStream as _useStream,
  FetchStreamTransport,
} from "@langchain/react";
import type { BagTemplate } from "@langchain/langgraph-sdk";
import type {
  ResolveStreamInterface,
  ResolveStreamOptions,
  UseStreamCustomOptions,
  InferBag,
  InferStateType,
} from "@langchain/langgraph-sdk/ui";
import { toMessageDict } from "../ui/messages.js";

export { FetchStreamTransport };

/**
 * Re-export of useStream that forces plain Message[] output
 * for backward compatibility with @langchain/langgraph-sdk/react users.
 */
export function useStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
>(
  options: ResolveStreamOptions<T, InferBag<T, Bag>>
): ResolveStreamInterface<T, InferBag<T, Bag>>;

export function useStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
>(
  options: UseStreamCustomOptions<InferStateType<T>, InferBag<T, Bag>>
): ResolveStreamInterface<T, InferBag<T, Bag>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useStream(...args: any[]): any {
  const options = args[0];
  return _useStream({
    ...options,
    toMessage: toMessageDict,
  });
}

export type {
  UseStream,
  UseStreamCustom,
  SubagentStream,
  SubagentStreamInterface,
} from "@langchain/react";
export type {
  BaseStream,
  UseAgentStream,
  UseAgentStreamOptions,
  UseDeepAgentStream,
  UseDeepAgentStreamOptions,
  ResolveStreamInterface,
  ResolveStreamOptions,
  InferStateType,
  InferToolCalls,
  InferSubagentStates,
  InferNodeNames,
  InferBag,
} from "@langchain/react";
export type {
  MessageMetadata,
  UseStreamOptions,
  UseStreamCustomOptions,
  UseStreamTransport,
  UseStreamThread,
  GetToolCallsType,
  AgentTypeConfigLike,
  IsAgentLike,
  ExtractAgentConfig,
  InferAgentToolCalls,
  SubagentToolCall,
  SubagentStatus,
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
} from "@langchain/react";
export type {
  ToolCallWithResult,
  ToolCallState,
  DefaultToolCall,
  ToolCallFromTool,
  ToolCallsFromTools,
} from "@langchain/react";
export {
  SubagentManager,
  extractToolCallIdFromNamespace,
  calculateDepthFromNamespace,
  extractParentIdFromNamespace,
  isSubagentNamespace,
} from "@langchain/react";
