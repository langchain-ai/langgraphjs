/**
 * Base stream types shared by all stream interfaces.
 *
 * This module contains the foundational types that are common to all streaming
 * scenarios: CompiledStateGraph, ReactAgent (createAgent), and DeepAgent (createDeepAgent).
 *
 * @module
 */

import type { Client } from "../../client.js";
import type { ThreadState, Interrupt } from "../../schema.js";
import type { StreamMode } from "../../types.stream.js";
import type { StreamEvent } from "../../types.js";
import type { Message, DefaultToolCall } from "../../types.messages.js";
import type { BagTemplate } from "../../types.template.js";
import type { Sequence } from "../branching.js";
import type {
  GetUpdateType,
  GetConfigurableType,
  GetInterruptType,
  MessageMetadata,
  SubmitOptions,
} from "../types.js";

/**
 * Base stream interface shared by all stream types.
 *
 * Contains core properties for state management, messaging, and stream control
 * that are common to CompiledStateGraph, ReactAgent, and DeepAgent streams.
 *
 * This interface provides the foundation that all stream types build upon:
 * - State management (`values`, `isLoading`, `error`)
 * - Message handling (`messages`)
 * - Interrupt handling (`interrupt`)
 * - Stream lifecycle (`submit`, `stop`)
 * - Branching and history (`branch`, `history`)
 *
 * @template StateType - The state type of the stream
 * @template ToolCall - The tool call type for messages (inferred from agent tools)
 * @template Bag - Type configuration bag for interrupts, configurable, updates, etc.
 *
 * @example
 * ```typescript
 * // BaseStream is not used directly - use one of the specialized interfaces:
 * // - UseGraphStream for CompiledStateGraph
 * // - UseAgentStream for ReactAgent (createAgent)
 * // - UseDeepAgentStream for DeepAgent (createDeepAgent)
 * ```
 */
export interface BaseStream<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  ToolCall = DefaultToolCall,
  Bag extends BagTemplate = BagTemplate
> {
  /**
   * The current state values of the stream.
   * Updated as streaming events are received.
   */
  values: StateType;

  /**
   * Last seen error from the stream, if any.
   * Reset to `undefined` when a new stream starts.
   */
  error: unknown;

  /**
   * Whether the stream is currently running.
   * `true` while streaming, `false` when idle or completed.
   */
  isLoading: boolean;

  /**
   * Whether the thread is currently being loaded.
   * `true` during initial thread data fetch.
   */
  isThreadLoading: boolean;

  /**
   * Messages accumulated during the stream.
   * Includes both human and AI messages.
   * AI messages include typed tool calls based on the agent's tools.
   */
  messages: Message<ToolCall>[];

  /**
   * Current interrupt, if the stream is interrupted.
   * Convenience alias for `interrupts[0]`.
   * For workflows with multiple concurrent interrupts, use `interrupts` instead.
   */
  interrupt: Interrupt<GetInterruptType<Bag>> | undefined;

  /**
   * All current interrupts from the stream.
   * When using Send() fan-out with per-task interrupt() calls,
   * multiple interrupts may be pending simultaneously.
   */
  interrupts: Interrupt<GetInterruptType<Bag>>[];

  /**
   * Stops the currently running stream.
   * @returns A promise that resolves when the stream is stopped.
   */
  stop: () => Promise<void>;

  /**
   * Create and stream a run to the thread.
   *
   * @param values - The input values to send, or null/undefined for empty input
   * @param options - Optional configuration for the submission
   * @returns A promise that resolves when the stream completes
   */
  submit: (
    values: GetUpdateType<Bag, StateType> | null | undefined,
    options?: SubmitOptions<StateType, GetConfigurableType<Bag>>
  ) => Promise<void>;

  /**
   * The current branch of the thread.
   * Used for navigating between different conversation branches.
   */
  branch: string;

  /**
   * Set the branch of the thread.
   * @param branch - The branch identifier to switch to
   */
  setBranch: (branch: string) => void;

  /**
   * Flattened history of thread states of a thread.
   * Contains all states in the current branch's history.
   */
  history: ThreadState<StateType>[];

  /**
   * Tree of all branches for the thread.
   * @experimental This API is experimental and subject to change.
   */
  experimental_branchTree: Sequence<StateType>;

  /**
   * Get the metadata for a message, such as first thread state the message
   * was seen in and branch information.
   *
   * @param message - The message to get the metadata for
   * @param index - The index of the message in the thread
   * @returns The metadata for the message, or undefined if not found
   */
  getMessagesMetadata: (
    message: Message<ToolCall>,
    index?: number
  ) => MessageMetadata<StateType> | undefined;

  /**
   * LangGraph SDK client used to send requests and receive responses.
   */
  client: Client;

  /**
   * The ID of the assistant to use.
   */
  assistantId: string;

  /**
   * Join an active stream that's already running.
   *
   * @param runId - The ID of the run to join
   * @param lastEventId - Optional last event ID for resuming from a specific point
   * @param options - Optional configuration for the stream
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

// Note: BaseStreamOptions is not defined here - we use UseStreamOptions from types.ts
// as the base for all stream option types. This avoids duplicating the extensive
// configuration options and ensures consistency.
