import type {
  BaseMessage,
  ToolMessage as CoreToolMessage,
  AIMessage as CoreAIMessage,
} from "@langchain/core/messages";

import type { ToolCallWithResult, DefaultToolCall } from "../types.messages.js";
import type {
  SubagentStreamInterface,
  AcceptBaseMessages,
  MessageMetadata,
} from "./types.js";
import type {
  HistoryWithBaseMessages,
  StateWithBaseMessages,
} from "./messages.js";
import type { QueueInterface } from "./queue.js";
import type { ThreadState } from "../schema.js";

/**
 * Remaps an SDK {@link ToolCallWithResult} so that the `toolMessage` and
 * `aiMessage` fields use `@langchain/core` class instances
 * (`CoreToolMessage` / `CoreAIMessage`) instead of plain SDK message
 * objects.
 *
 * Framework SDKs convert messages to class instances at runtime via
 * `ensureMessageInstances`; this type reflects that conversion at the
 * type level.
 */
export type ClassToolCallWithResult<T> =
  T extends ToolCallWithResult<infer TC, unknown, unknown>
    ? ToolCallWithResult<TC, CoreToolMessage, CoreAIMessage>
    : T;

/**
 * Subagent stream interface with `messages` typed as `BaseMessage[]`
 * instead of `Message[]`.
 *
 * Framework SDKs use class message instances end-to-end; this type is
 * the subagent counterpart of {@link WithClassMessages}.
 */
export type ClassSubagentStreamInterface<
  StateType = Record<string, unknown>,
  ToolCall = DefaultToolCall,
  SubagentName extends string = string,
> = Omit<
  SubagentStreamInterface<StateType, ToolCall, SubagentName>,
  "messages" | "values"
> & {
  messages: BaseMessage[];
  values: StateWithBaseMessages<StateType>;
};

type StreamState<T> = T extends {
  getMessagesMetadata: (
    message: unknown,
    index?: number
  ) => MessageMetadata<infer S> | undefined;
}
  ? S extends Record<string, unknown>
    ? S
    : Record<string, unknown>
  : T extends { history: ThreadState<infer S>[] }
    ? S extends Record<string, unknown>
      ? S
      : Record<string, unknown>
    : T extends { values: infer V }
      ? V extends Record<string, unknown>
        ? V
        : Record<string, unknown>
      : Record<string, unknown>;

type ClassOptimisticValues<StateType> =
  StateType extends Record<string, unknown>
    ?
        | Partial<StateWithBaseMessages<StateType>>
        | ((
            prev: StateWithBaseMessages<StateType>
          ) => Partial<StateWithBaseMessages<StateType>>)
    : never;

type WithClassSubmitOptions<StateType, Options> = Options extends {
  optimisticValues?: unknown;
}
  ? Omit<Options, "optimisticValues"> & {
      optimisticValues?: ClassOptimisticValues<StateType>;
    }
  : Options;

/**
 * Maps a stream interface to use `@langchain/core` {@link BaseMessage}
 * class instances instead of plain SDK {@link Message} objects.
 *
 * Specifically:
 * - `messages` becomes `BaseMessage[]`
 * - `getMessagesMetadata` accepts a `BaseMessage`
 * - `toolCalls` uses {@link ClassToolCallWithResult}
 * - `getToolCalls` accepts `CoreAIMessage` and returns class-based
 *   tool call results
 * - `submit` accepts `BaseMessage` via {@link AcceptBaseMessages}
 * - `history` is remapped via {@link HistoryWithBaseMessages}
 * - Subagent properties use {@link ClassSubagentStreamInterface}
 *
 * React, Angular, and Svelte use this type directly. Vue applies
 * additional `Ref`/`ComputedRef` wrapping on top of the shared helper
 * types.
 */
export type WithClassMessages<T> = Omit<
  T,
  | "messages"
  | "values"
  | "history"
  | "getMessagesMetadata"
  | "toolCalls"
  | "getToolCalls"
  | "submit"
  | "queue"
  | "subagents"
  | "activeSubagents"
  | "getSubagent"
  | "getSubagentsByType"
  | "getSubagentsByMessage"
> & {
  messages: BaseMessage[];
  values: StateWithBaseMessages<StreamState<T>>;
  getMessagesMetadata: (
    message: BaseMessage,
    index?: number
  ) => MessageMetadata<StateWithBaseMessages<StreamState<T>>> | undefined;
} & ("history" extends keyof T
    ? { history: HistoryWithBaseMessages<T["history"]> }
    : unknown) &
  ("submit" extends keyof T
    ? {
        submit: T extends {
          submit: (values: infer V, options?: infer O) => infer Ret;
        }
          ? (
              values:
                | AcceptBaseMessages<Exclude<V, null | undefined>>
                | null
                | undefined,
              options?: WithClassSubmitOptions<StreamState<T>, O>
            ) => Ret
          : never;
      }
    : unknown) &
  ("queue" extends keyof T
    ? {
        queue: T extends { queue: QueueInterface<infer S, infer O> }
          ? QueueInterface<
              StateWithBaseMessages<S>,
              WithClassSubmitOptions<S, O>
            >
          : never;
      }
    : unknown) &
  ("toolCalls" extends keyof T
    ? {
        toolCalls: T extends { toolCalls: (infer TC)[] }
          ? ClassToolCallWithResult<TC>[]
          : never;
      }
    : unknown) &
  ("getToolCalls" extends keyof T
    ? {
        getToolCalls: T extends {
          getToolCalls: (message: infer _M) => (infer TC)[];
        }
          ? (message: CoreAIMessage) => ClassToolCallWithResult<TC>[]
          : never;
      }
    : unknown) &
  ("subagents" extends keyof T
    ? {
        subagents: T extends {
          subagents: Map<
            string,
            SubagentStreamInterface<infer S, infer TC, infer N>
          >;
        }
          ? Map<string, ClassSubagentStreamInterface<S, TC, N>>
          : never;
        activeSubagents: T extends {
          activeSubagents: SubagentStreamInterface<
            infer S,
            infer TC,
            infer N
          >[];
        }
          ? ClassSubagentStreamInterface<S, TC, N>[]
          : never;
        getSubagent: T extends {
          getSubagent: (
            id: string
          ) => SubagentStreamInterface<infer S, infer TC, infer N> | undefined;
        }
          ? (
              toolCallId: string
            ) => ClassSubagentStreamInterface<S, TC, N> | undefined
          : never;
        getSubagentsByType: T extends {
          getSubagentsByType: (
            type: string
          ) => SubagentStreamInterface<infer S, infer TC, infer N>[];
        }
          ? (type: string) => ClassSubagentStreamInterface<S, TC, N>[]
          : never;
        getSubagentsByMessage: T extends {
          getSubagentsByMessage: (
            id: string
          ) => SubagentStreamInterface<infer S, infer TC, infer N>[];
        }
          ? (messageId: string) => ClassSubagentStreamInterface<S, TC, N>[]
          : never;
      }
    : unknown);
