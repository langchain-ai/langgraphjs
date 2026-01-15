/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */
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
   * Includes all message types including ToolMessage.
   */
  messages: Message<GetToolCallsType<StateType>>[];

  /**
   * Tool calls paired with their results.
   * Useful for rendering tool invocations and their outputs together.
   *
   * Each item contains the tool call from an AI message paired with its
   * corresponding ToolMessage result (if available), along with lifecycle state.
   *
   * @example
   * ```tsx
   * // With type-safe tool calls - embed the type in your messages
   * type MyToolCalls =
   *   | { name: "get_weather"; args: { location: string }; id?: string }
   *   | { name: "search"; args: { query: string }; id?: string };
   *
   * interface MyState {
   *   messages: Message<MyToolCalls>[];
   * }
   *
   * const stream = useStream<MyState>({ ... });
   *
   * {stream.toolCalls.map(({ id, call, result, state }) => {
   *   if (call.name === "get_weather") {
   *     // call.args is { location: string }
   *     return (
   *       <WeatherCard
   *         key={id}
   *         location={call.args.location}
   *         result={result?.content}
   *         isLoading={state === "pending"}
   *       />
   *     );
   *   }
   * })}
   * ```
   */
  toolCalls: ToolCallWithResult<GetToolCallsType<StateType>>[];

  /**
   * Get tool calls for a specific AI message.
   * Useful when rendering messages and their associated tool calls together.
   *
   * @param message - The AI message to get tool calls for.
   * @returns Array of tool calls initiated by the message.
   *
   * @example
   * ```tsx
   * {stream.uiMessages.map((message) => {
   *   if (message.type === "ai") {
   *     const toolCalls = stream.getToolCalls(message);
   *     if (toolCalls.length > 0) {
   *       return (
   *         <div key={message.id}>
   *           {toolCalls.map(tc => <ToolCard key={tc.id} toolCall={tc} />)}
   *         </div>
   *       );
   *     }
   *   }
   *   return <MessageBubble key={message.id} message={message} />;
   * })}
   * ```
   */
  getToolCalls: (
    message: AIMessage<GetToolCallsType<StateType>>
  ) => ToolCallWithResult<GetToolCallsType<StateType>>[];

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
