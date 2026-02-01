/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */
import type { ComputedRef, Ref } from "vue";
import type { Client } from "../client.js";

import type { ThreadState, Interrupt } from "../schema.js";
import type {
  Message,
  AIMessage,
  ToolCallWithResult,
} from "../types.messages.js";
import type { StreamMode } from "../types.stream.js";
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
} from "../ui/types.js";
import type { BagTemplate } from "../types.template.js";
import type { StreamEvent } from "../types.js";

// Re-export shared types from ui/types.ts
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
};

export interface UseStream<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
> {
  /**
   * The current values of the thread.
   */
  values: ComputedRef<StateType>;

  /**
   * Last seen error from the thread or during streaming.
   */
  error: ComputedRef<unknown>;

  /**
   * Whether the stream is currently running.
   */
  isLoading: ComputedRef<boolean>;

  /**
   * Whether the thread is currently being loaded.
   */
  isThreadLoading: ComputedRef<boolean>;

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
  branch: Ref<string>;

  /**
   * Set the branch of the thread.
   */
  setBranch: (branch: string) => void;

  /**
   * Flattened history of thread states of a thread.
   */
  history: ComputedRef<ThreadState<StateType>[]>;

  /**
   * Tree of all branches for the thread.
   * @experimental
   */
  experimental_branchTree: ComputedRef<Sequence<StateType>>;

  /**
   * Get the interrupt value for the stream if interrupted.
   */
  interrupt: ComputedRef<Interrupt<GetInterruptType<Bag>> | undefined>;

  /**
   * Messages inferred from the thread.
   * Will automatically update with incoming message chunks.
   * Includes all message types including ToolMessage.
   */
  messages: ComputedRef<Message<GetToolCallsType<StateType>>[]>;

  /**
   * Tool calls paired with their results.
   */
  toolCalls: ComputedRef<ToolCallWithResult<GetToolCallsType<StateType>>[]>;

  /**
   * Get tool calls for a specific AI message.
   */
  getToolCalls: (
    message: AIMessage<GetToolCallsType<StateType>>
  ) => ToolCallWithResult<GetToolCallsType<StateType>>[];

  /**
   * Get the metadata for a message, such as first thread state the message
   * was seen in and branch information.
   */
  getMessagesMetadata: (
    message: Message<GetToolCallsType<StateType>>,
    index?: number
  ) => MessageMetadata<StateType> | undefined;

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
  Bag extends BagTemplate = BagTemplate
> = Pick<
  UseStream<StateType, Bag>,
  | "values"
  | "error"
  | "isLoading"
  | "stop"
  | "interrupt"
  | "messages"
  | "toolCalls"
  | "getToolCalls"
> & {
  submit: (
    values: GetUpdateType<Bag, StateType> | null | undefined,
    options?: CustomSubmitOptions<StateType, GetConfigurableType<Bag>>
  ) => Promise<void>;
};
