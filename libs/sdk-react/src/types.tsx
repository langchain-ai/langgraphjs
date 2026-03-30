/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */
import type { BaseMessage } from "@langchain/core/messages";
import type {
  Client,
  ThreadState,
  StreamMode,
  ToolProgress,
  BagTemplate,
  StreamEvent,
} from "@langchain/langgraph-sdk";
import type {
  Sequence,
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
  QueueEntry,
  QueueInterface,
} from "@langchain/langgraph-sdk/ui";

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
  // Queue types
  QueueEntry,
  QueueInterface,
};

export interface UseStream<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
  SubagentStates extends Record<string, unknown> = DefaultSubagentStates,
> extends Omit<
  StreamBase<
    StateType,
    GetToolCallsType<StateType>,
    GetInterruptType<Bag>,
    SubagentStates
  >,
  "messages"
> {
  /**
   * Messages accumulated during the stream as @langchain/core class instances.
   */
  messages: BaseMessage[];

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
    message: BaseMessage,
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

  /**
   * Switch to a different thread, clearing the current stream state.
   * Pass `null` to reset to no thread (a new thread will be created on next submit).
   */
  switchThread: (newThreadId: string | null) => void;

  /**
   * Server-side submission queue. Pending runs created via
   * `multitaskStrategy: "enqueue"` when submitting while the agent is busy.
   */
  queue: QueueInterface<
    StateType,
    SubmitOptions<StateType, GetConfigurableType<Bag>>
  >;
}

/**
 * Return type for {@link useSuspenseStream}.
 *
 * Identical to {@link UseStream} but without `isLoading`, `error`, and
 * `isThreadLoading` (those states are handled by Suspense / Error Boundaries).
 * An `isStreaming` flag is provided instead to indicate whether tokens are
 * currently being received from the server.
 */
export type UseSuspenseStream<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
  SubagentStates extends Record<string, unknown> = DefaultSubagentStates,
> = Omit<
  UseStream<StateType, Bag, SubagentStates>,
  "isLoading" | "error" | "isThreadLoading"
> & {
  /**
   * Whether the stream is currently receiving data from the server.
   * Unlike Suspense-based loading, streaming is incremental and the
   * component stays rendered throughout.
   */
  isStreaming: boolean;
};

export type UseStreamCustom<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
  SubagentStates extends Record<string, unknown> = DefaultSubagentStates,
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
  | "getMessagesMetadata"
  | "branch"
  | "setBranch"
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

  switchThread: (newThreadId: string | null) => void;

  /**
   * Server-side submission queue. Always empty for custom transport hooks.
   */
  queue: QueueInterface<
    StateType,
    CustomSubmitOptions<StateType, GetConfigurableType<Bag>>
  >;
};
