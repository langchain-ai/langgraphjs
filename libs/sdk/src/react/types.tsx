import type { Client } from "../client.js";

import type {
  ThreadState,
  Interrupt,
  Config,
  Checkpoint,
  Metadata,
} from "../schema.js";
import type {
  Command,
  MultitaskStrategy,
  OnCompletionBehavior,
  DisconnectMode,
  Durability,
} from "../types.js";
import type { Message } from "../types.messages.js";
import type { StreamMode } from "../types.stream.js";
import type { Sequence } from "../ui/branching.js";
import type {
  BagTemplate,
  GetUpdateType,
  GetConfigurableType,
  GetInterruptType,
  MessageMetadata,
  UseStreamThread,
  UseStreamOptions,
  UseStreamTransport,
} from "../ui/index.js";

export interface UseStream<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
> {
  /**
   * The current values of the thread.
   */
  values: StateType;

  /**
   * Last seen error from the thread or during streaming.
   */
  error: unknown;

  /**
   * Whether the stream is currently running.
   */
  isLoading: boolean;

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
   * Get the interrupt value for the stream if interrupted.
   */
  interrupt: Interrupt<GetInterruptType<Bag>> | undefined;

  /**
   * Messages inferred from the thread.
   * Will automatically update with incoming message chunks.
   */
  messages: Message[];

  /**
   * Get the metadata for a message, such as first thread state the message
   * was seen in and branch information.
   
   * @param message - The message to get the metadata for.
   * @param index - The index of the message in the thread.
   * @returns The metadata for the message.
   */
  getMessagesMetadata: (
    message: Message,
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
    options?: { streamMode?: StreamMode | StreamMode[] }
  ) => Promise<void>;
}

type ConfigWithConfigurable<ConfigurableType extends Record<string, unknown>> =
  Config & { configurable?: ConfigurableType };

export interface SubmitOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  ContextType extends Record<string, unknown> = Record<string, unknown>
> {
  config?: ConfigWithConfigurable<ContextType>;
  context?: ContextType;
  checkpoint?: Omit<Checkpoint, "thread_id"> | null;
  command?: Command;
  interruptBefore?: "*" | string[];
  interruptAfter?: "*" | string[];
  metadata?: Metadata;
  multitaskStrategy?: MultitaskStrategy;
  onCompletion?: OnCompletionBehavior;
  onDisconnect?: DisconnectMode;
  feedbackKeys?: string[];
  streamMode?: Array<StreamMode>;
  runId?: string;
  optimisticValues?:
    | Partial<StateType>
    | ((prev: StateType) => Partial<StateType>);

  /**
   * Whether or not to stream the nodes of any subgraphs called
   * by the assistant.
   * @default false
   */
  streamSubgraphs?: boolean;

  /**
   * Mark the stream as resumable. All events emitted during the run will be temporarily persisted
   * in order to be re-emitted if the stream is re-joined.
   * @default false
   */
  streamResumable?: boolean;

  /**
   * Whether to checkpoint during the run (or only at the end/interruption).
   * - `"async"`: Save checkpoint asynchronously while the next step executes (default).
   * - `"sync"`: Save checkpoint synchronously before the next step starts.
   * - `"exit"`: Save checkpoint only when the graph exits.
   * @default "async"
   */
  durability?: Durability;

  /**
   * The ID to use when creating a new thread. When provided, this ID will be used
   * for thread creation when threadId is `null` or `undefined`.
   * This enables optimistic UI updates where you know the thread ID
   * before the thread is actually created.
   */
  threadId?: string;
}

export type UseStreamCustomOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
> = Pick<
  UseStreamOptions<StateType, Bag>,
  | "messagesKey"
  | "threadId"
  | "onThreadId"
  | "onError"
  | "onCreated"
  | "onUpdateEvent"
  | "onCustomEvent"
  | "onMetadataEvent"
  | "onLangChainEvent"
  | "onDebugEvent"
  | "onCheckpointEvent"
  | "onTaskEvent"
  | "onStop"
  | "initialValues"
> & {
  transport: UseStreamTransport<StateType, Bag>;
  thread?: UseStreamThread<StateType>;
};

export type UseStreamCustom<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
> = Pick<
  UseStream<StateType, Bag>,
  "values" | "error" | "isLoading" | "stop" | "interrupt" | "messages"
> & {
  submit: (
    values: GetUpdateType<Bag, StateType> | null | undefined,
    options?: CustomSubmitOptions<StateType, GetConfigurableType<Bag>>
  ) => Promise<void>;
};

export type CustomSubmitOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  ConfigurableType extends Record<string, unknown> = Record<string, unknown>
> = Pick<
  SubmitOptions<StateType, ConfigurableType>,
  "optimisticValues" | "context" | "command" | "config"
>;
