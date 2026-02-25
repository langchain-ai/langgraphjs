/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */
import type { Client } from "../client.js";

import type { ThreadState } from "../schema.js";
import type { Message } from "../types.messages.js";
import type { StreamMode, ToolProgress } from "../types.stream.js";
import type { Sequence } from "../ui/branching.js";
import type {
  GetUpdateType,
  GetConfigurableType,
  GetInterruptType,
  GetToolCallsType,
  MessageMetadata,
  UseStreamThread,
  UseStreamOptions,
  UseStreamTransport,
  UseStreamCustomOptions,
  SubmitOptions,
  CustomSubmitOptions,
  RunCallbackMeta,
  SubagentStream,
  SubagentStreamInterface,
  StreamBase,
  DefaultSubagentStates,
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
  BaseSubagentState,
} from "../ui/types.js";
import type { BagTemplate } from "../types.template.js";
import type { StreamEvent } from "../types.js";

// Re-export types from ui/types.ts
export type {
  GetUpdateType,
  GetConfigurableType,
  GetInterruptType,
  GetToolCallsType,
  MessageMetadata,
  UseStreamThread,
  UseStreamOptions,
  UseStreamTransport,
  UseStreamCustomOptions,
  SubmitOptions,
  CustomSubmitOptions,
  RunCallbackMeta,
  SubagentStream,
  SubagentStreamInterface,
  StreamBase,
  DefaultSubagentStates,
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
  BaseSubagentState,
};

export interface UseStream<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
  SubagentStates extends Record<string, unknown> = DefaultSubagentStates
> extends StreamBase<
    StateType,
    GetToolCallsType<StateType>,
    GetInterruptType<Bag>,
    SubagentStates
  > {
  /**
   * Whether the thread is currently being loaded.
   */
  isThreadLoading: boolean;

  /**
   * Stops the stream.
   */
  stop: () => Promise<void>;

  /**
   * Create and stream a run to the thread.
   */
  submit: (
    values: GetUpdateType<Bag, StateType> | null | undefined,
    options?: SubmitOptions<StateType, GetConfigurableType<Bag>>
  ) => Promise<void>;

  /**
   * The current branch of the thread.
   */
  branch: string;

  /**
   * Set the branch of the thread.
   */
  setBranch: (branch: string) => void;

  /**
   * Flattened history of thread states of a thread.
   */
  history: ThreadState<StateType>[];

  /**
   * Tree of all branches for the thread.
   * @experimental
   */
  experimental_branchTree: Sequence<StateType>;

  /**
   * Get the metadata for a message, such as first thread state the message
   * was seen in and branch information.
   *
   * @param message - The message to get the metadata for.
   * @param index - The index of the message in the thread.
   * @returns The metadata for the message.
   */
  getMessagesMetadata: (
    message: Message<GetToolCallsType<StateType>>,
    index?: number
  ) => MessageMetadata<StateType> | undefined;

  /**
   * Progress of tool executions during streaming.
   */
  toolProgress: ToolProgress[];

  /**
   * LangGraph SDK client used to send request and receive responses.
   */
  client: Client;

  /**
   * The ID of the assistant to use.
   */
  assistantId: string;

  /**
   * Join an active stream.
   */
  joinStream: (
    runId: string,
    lastEventId?: string,
    options?: {
      streamMode?: StreamMode | StreamMode[];
      filter?: (event: {
        id?: string;
        event: StreamEvent;
        data: unknown;
      }) => boolean;
    }
  ) => Promise<void>;
}

export type UseStreamCustom<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
  SubagentStates extends Record<string, unknown> = DefaultSubagentStates
> = Pick<
  UseStream<StateType, Bag, SubagentStates>,
  | "values"
  | "error"
  | "isLoading"
  | "stop"
  | "interrupt"
  | "interrupts"
  | "messages"
  | "toolCalls"
  | "getToolCalls"
  | "subagents"
  | "activeSubagents"
  | "getSubagent"
  | "getSubagentsByType"
  | "getSubagentsByMessage"
> & {
  submit: (
    values: GetUpdateType<Bag, StateType> | null | undefined,
    options?: CustomSubmitOptions<StateType, GetConfigurableType<Bag>>
  ) => Promise<void>;
};
