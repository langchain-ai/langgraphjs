/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */
import type { Client, ClientConfig } from "../client.js";

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
import type { Message, ToolCallWithResult } from "../types.messages.js";
import type { StreamMode } from "../types.stream.js";
import type { Sequence } from "../ui/branching.js";
import type {
  BagTemplate,
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

// Re-export types from ui/types.ts
export type {
  BagTemplate,
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
  messages: Message<GetToolCallsType<Bag>>[];

  /**
   * Tool calls paired with their results.
   * Useful for rendering tool invocations and their outputs together.
   *
   * Each item contains the tool call from an AI message paired with its
   * corresponding ToolMessage result (if available).
   *
   * @example
   * ```tsx
   * // With type-safe tool calls
   * type MyToolCalls =
   *   | { name: "get_weather"; args: { location: string }; id?: string }
   *   | { name: "search"; args: { query: string }; id?: string };
   *
   * const stream = useStream<MyState, { ToolCallsType: MyToolCalls }>({ ... });
   *
   * {stream.toolCalls.map(({ call, result }) => {
   *   if (call.name === "get_weather") {
   *     // call.args is { location: string }
   *     return <WeatherCard location={call.args.location} result={result?.content} />;
   *   }
   *   if (call.name === "search") {
   *     // call.args is { query: string }
   *     return <SearchResults query={call.args.query} result={result?.content} />;
   *   }
   * })}
   * ```
   */
  toolCalls: ToolCallWithResult<GetToolCallsType<Bag>>[];

  /**
   * Get the metadata for a message, such as first thread state the message
   * was seen in and branch information.
   *
   * @param message - The message to get the metadata for.
   * @param index - The index of the message in the thread.
   * @returns The metadata for the message.
   */
  getMessagesMetadata: (
    message: Message<GetToolCallsType<Bag>>,
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
> & {
  submit: (
    values: GetUpdateType<Bag, StateType> | null | undefined,
    options?: CustomSubmitOptions<StateType, GetConfigurableType<Bag>>
  ) => Promise<void>;
};
