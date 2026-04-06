import { Injectable, inject as angularInject } from "@angular/core";
import type { Signal, WritableSignal } from "@angular/core";
import type {
  BaseMessage,
  ToolMessage as CoreToolMessage,
  AIMessage as CoreAIMessage,
} from "@langchain/core/messages";
import type {
  MessageMetadata,
  SubmitOptions,
  ResolveStreamOptions,
  ResolveStreamInterface,
  InferBag,
  InferStateType,
  AcceptBaseMessages,
  UseStreamCustomOptions,
  SubagentStreamInterface,
  WithClassMessages,
  GetConfigurableType,
  GetInterruptType,
} from "@langchain/langgraph-sdk/ui";

import {
  Client,
  type StreamEvent,
  type StreamMode,
  type Message,
  type Interrupt,
  type BagTemplate,
  type ToolCallWithResult as SdkToolCallWithResult,
  type DefaultToolCall,
} from "@langchain/langgraph-sdk";
import type { StreamServiceInstance } from "./stream-service-instance.js";
import { injectStreamCustom } from "./stream.custom.js";
import { useStreamLGP } from "./stream.lgp.js";
import { STREAM_INSTANCE } from "./context.js";

export { injectStreamCustom, useStreamCustom } from "./stream.custom.js";
export { FetchStreamTransport } from "@langchain/langgraph-sdk/ui";
export {
  provideStreamDefaults,
  provideStream,
  STREAM_DEFAULTS,
  STREAM_INSTANCE,
} from "./context.js";
export type { StreamDefaults } from "./context.js";
export type { ClassSubagentStreamInterface } from "@langchain/langgraph-sdk/ui";

type AngularWritableKeys = "isLoading" | "branch";

type AngularPlainKeys =
  | "submit"
  | "stop"
  | "joinStream"
  | "switchThread"
  | "setBranch"
  | "getMessagesMetadata"
  | "getToolCalls"
  | "getSubagent"
  | "getSubagentsByType"
  | "getSubagentsByMessage"
  | "client"
  | "assistantId";

type AngularQueueInterface<T> = T extends {
  entries: infer E;
  size: infer S;
  cancel: infer C;
  clear: infer Cl;
}
  ? {
      entries: WritableSignal<E>;
      size: WritableSignal<S>;
      cancel: C;
      clear: Cl;
    }
  : T;

type AngularSignalWrap<T> = {
  [K in keyof T]: K extends AngularPlainKeys
    ? T[K]
    : K extends AngularWritableKeys
      ? WritableSignal<T[K]>
      : K extends "queue"
        ? AngularQueueInterface<T[K]>
        : Signal<T[K]>;
};

/**
 * Injects the shared stream instance from the nearest ancestor that provided
 * one via {@link provideStream}. Throws if no ancestor provides a stream
 * instance.
 *
 * @example
 * ```typescript
 * import { Component } from "@angular/core";
 * import { injectStream } from "@langchain/angular";
 *
 * @Component({
 *   template: `
 *     @for (msg of stream.messages(); track msg.id) {
 *       <div>{{ msg.content }}</div>
 *     }
 *     <button
 *       [disabled]="stream.isLoading()"
 *       (click)="onSubmit()"
 *     >Send</button>
 *   `,
 * })
 * export class ChatComponent {
 *   stream = injectStream();
 *
 *   onSubmit() {
 *     void this.stream.submit({
 *       messages: [{ type: "human", content: "Hello!" }],
 *     });
 *   }
 * }
 * ```
 *
 * @example With type parameters for full type safety:
 * ```typescript
 * import type { agent } from "./agent";
 *
 * export class ChatComponent {
 *   stream = injectStream<typeof agent>();
 *   // stream.messages() returns typed messages
 * }
 * ```
 */
function injectStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(): AngularSignalWrap<
  WithClassMessages<ResolveStreamInterface<T, InferBag<T, Bag>>>
>;

/**
 * Angular entry point for LangGraph streaming. Call from a component, directive,
 * or service field initializer to get a **Signals-based** stream controller
 * connected to the LangGraph Platform (HTTP + threads API).
 *
 * The returned object mirrors the shared `useStream` API from
 * `@langchain/langgraph-sdk/ui`, but reactive fields are
 * {@link https://angular.dev/guide/signals | Angular `Signal`s}:
 * read state with calls like `stream.messages()`, `stream.values()`, and
 * `stream.isLoading()`, and use `WritableSignal` setters where exposed (for
 * example `stream.branch` for branch selection).
 *
 * ## Typing with `createDeepAgent`
 *
 * Expect `export const agent = createDeepAgent({ ... })` from `deepagents`. In
 * UI code, `import { type agent } from "./agent"` (or `import type { agent }`)
 * is a **type-only** import: it is erased when compiling, so the agent module
 * does not run in the browser. You still pass **`typeof agent`** to
 * `injectStream`, not `agent` alone — `agent` is a value; TypeScript only
 * accepts it in a type position via `typeof` (otherwise: *refers to a value,
 * but is being used as a type*). If you prefer a named type in generics, add
 * `export type Agent = typeof agent` next to the const and use
 * `injectStream<Agent>(...)`.
 *
 * @example
 * ```typescript
 * // agent.ts
 * import { createDeepAgent } from "deepagents";
 * import { tool } from "langchain";
 * import { z } from "zod";
 *
 * const getWeather = tool(
 *   async ({ location }) => `Weather in ${location}`,
 *   { name: "get_weather", schema: z.object({ location: z.string() }) },
 * );
 *
 * export const agent = createDeepAgent({
 *   model: "openai:gpt-4o",
 *   tools: [getWeather],
 * });
 *
 * // chat.component.ts — type-only import; no agent runtime in the frontend
 * import { Component } from "@angular/core";
 * import { injectStream } from "@langchain/angular";
 * import { type agent } from "./agent";
 *
 * @Component({
 *   standalone: true,
 *   template: `
 *     @for (msg of stream.messages(); track msg.id ?? $index) {
 *       <p>{{ msg.content }}</p>
 *     }
 *   `,
 * })
 * export class ChatComponent {
 *   readonly stream = injectStream<typeof agent>({
 *     assistantId: "agent",
 *     apiUrl: "http://localhost:2024",
 *   });
 *   // stream.toolCalls()[0].call.name is typed as "get_weather"
 * }
 * ```
 *
 * ## Typing with `StateGraph` / custom graph state
 *
 * Use your graph state interface as `T` and embed tool call unions in
 * `Message<...>[]` when you need discriminated tool types.
 *
 * @example
 * ```typescript
 * import { Message } from "@langchain/langgraph-sdk";
 * import { Component } from "@angular/core";
 * import { injectStream } from "@langchain/angular";
 *
 * type MyToolCalls =
 *   | { name: "search"; args: { query: string }; id?: string }
 *   | { name: "calculate"; args: { expression: string }; id?: string };
 *
 * interface MyGraphState {
 *   messages: Message<MyToolCalls>[];
 *   context?: string;
 * }
 *
 * @Component({ standalone: true, template: "" })
 * export class ChatComponent {
 *   readonly stream = injectStream<MyGraphState>({
 *     assistantId: "my-graph",
 *     apiUrl: "http://localhost:2024",
 *   });
 *   // stream.values() is typed as MyGraphState | null
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Optional bag for interrupts, configurable, custom events, and updates
 * import { Component } from "@angular/core";
 * import { injectStream } from "@langchain/angular";
 * import type { Message } from "@langchain/langgraph-sdk";
 *
 * interface MyGraphState {
 *   messages: Message[];
 * }
 *
 * @Component({ standalone: true, template: "" })
 * export class ChatComponent {
 *   readonly stream = injectStream<
 *     MyGraphState,
 *     {
 *       InterruptType: { question: string };
 *       ConfigurableType: { userId: string };
 *     }
 *   >({
 *     assistantId: "my-graph",
 *     apiUrl: "http://localhost:2024",
 *   });
 *   // stream.interrupt() is typed as { question: string } | undefined
 * }
 * ```
 *
 * ## Subagent streaming
 *
 * For `createDeepAgent` agents with `subagents`, set `filterSubagentMessages`
 * and use `streamSubgraphs` on `submit` to populate `stream.subagents` and
 * related helpers.
 *
 * @example
 * ```typescript
 * import { Component } from "@angular/core";
 * import { injectStream } from "@langchain/angular";
 * import { type agent } from "./agent";
 *
 * @Component({ standalone: true, template: "" })
 * export class DeepAgentChatComponent {
 *   readonly stream = injectStream<typeof agent>({
 *     assistantId: "deepagent",
 *     apiUrl: "http://localhost:2024",
 *     filterSubagentMessages: true,
 *   });
 *
 *   send(content: string) {
 *     void this.stream.submit(
 *       { messages: [{ content, type: "human" }] },
 *       { streamSubgraphs: true },
 *     );
 *   }
 * }
 * ```
 *
 * @param options - LangGraph Platform client options (`apiUrl` or `client`),
 *   `assistantId`, stream modes, history, reconnect, subagent settings, etc.
 *
 * @returns A stream controller backed by Signals: graph values, messages,
 *   loading and error state, interrupts, tool calls, branching, queue, and
 *   `submit` / `stop` / `switchThread` helpers (writable where the UI layer
 *   requires mutation).
 *
 * @template T Agent type (with `~agentTypes`) from `createDeepAgent` or
 *   `createAgent`, or a state shape extending `Record<string, unknown>`.
 * @template Bag Optional configuration bag:
 *   - `ConfigurableType` — `config.configurable` typing
 *   - `InterruptType` — human-in-the-loop interrupt payloads
 *   - `CustomEventType` — custom stream events
 *   - `UpdateType` — payload typing for `submit`
 *
 * @see {@link https://docs.langchain.com/oss/javascript/langgraph/overview | LangGraph JavaScript overview}
 * @see {@link https://docs.langchain.com/oss/javascript/langchain/overview | LangChain JavaScript overview}
 * @see {@link https://docs.langchain.com/oss/javascript/deepagents/overview | Deep Agents JavaScript overview}
 */
function injectStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(
  options: ResolveStreamOptions<T, InferBag<T, Bag>>
): AngularSignalWrap<
  WithClassMessages<ResolveStreamInterface<T, InferBag<T, Bag>>>
>;

/**
 * Overload for a **custom transport** (`options.transport`), for example
 * {@link FetchStreamTransport} or any implementation compatible with
 * {@link injectStreamCustom}. Prefer {@link injectStreamCustom} directly when
 * you only use custom transports and want a narrower import.
 *
 * @param options - Custom transport and stream options (must include
 *   `transport`).
 *
 * @returns The same Signals-based controller shape as the LangGraph Platform
 *   overload.
 *
 * @template T Agent type or state shape, matching the custom transport.
 * @template Bag Same optional bag as the platform overload.
 *
 * @see {@link injectStreamCustom}
 */
function injectStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(
  options: UseStreamCustomOptions<InferStateType<T>, InferBag<T, Bag>>
): AngularSignalWrap<
  WithClassMessages<ResolveStreamInterface<T, InferBag<T, Bag>>>
>;

/**
 * @internal Merges DI, LangGraph Platform, and custom transport overloads.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function injectStream(options?: any): any {
  if (arguments.length === 0) {
    const instance = angularInject(STREAM_INSTANCE, { optional: true });
    if (instance == null) {
      throw new Error(
        "injectStream() requires an ancestor component to provide a stream via provideStream(). " +
          "Add provideStream({ assistantId: '...' }) to the providers array of a parent component, " +
          "or use injectStream(options) directly."
      );
    }
    return instance;
  }
  if ("transport" in options) {
    return injectStreamCustom(options);
  }
  return useStreamLGP(options);
}

export { injectStream };

/**
 * @deprecated Use `injectStream` instead. `useStream` will be removed in a
 * future major version. `injectStream` follows Angular's `inject*` naming
 * convention for injection-based patterns.
 */
export const useStream = injectStream;

export { useStreamLGP } from "./stream.lgp.js";

/**
 * Injectable Angular service that wraps {@link injectStream}.
 *
 * Extend this class with your own `@Injectable()` service and call
 * `super(options)` in the constructor:
 *
 * ```ts
 * \@Injectable({ providedIn: 'root' })
 * export class ChatService extends StreamService {
 *   constructor() {
 *     super({ assistantId: 'agent', apiUrl: '...' });
 *   }
 * }
 * ```
 *
 * The service exposes the same signals and methods as `injectStream`
 * (e.g. `values`, `messages`, `isLoading`, `submit`, `stop`).
 *
 * Must be created within an Angular injection context (via DI or
 * `runInInjectionContext`).
 */
@Injectable()
export class StreamService<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
> {
  private readonly _stream: StreamServiceInstance<T, Bag>;

  constructor(
    options:
      | ResolveStreamOptions<T, InferBag<T, Bag>>
      | UseStreamCustomOptions<InferStateType<T>, InferBag<T, Bag>>
  ) {
    this._stream = injectStream(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options as any
    ) as unknown as StreamServiceInstance<T, Bag>;
  }

  get values(): Signal<T> {
    return this._stream.values;
  }

  get messages(): Signal<BaseMessage[]> {
    return this._stream.messages;
  }

  get isLoading(): WritableSignal<boolean> {
    return this._stream.isLoading;
  }

  get error(): Signal<unknown> {
    return this._stream.error;
  }

  get branch(): WritableSignal<string> {
    return this._stream.branch;
  }

  get interrupt(): Signal<Interrupt<GetInterruptType<Bag>> | undefined> {
    return this._stream.interrupt;
  }

  get interrupts(): Signal<Interrupt<GetInterruptType<Bag>>[]> {
    return this._stream.interrupts;
  }

  get toolCalls(): Signal<SdkToolCallWithResult<DefaultToolCall>[]> {
    return this._stream.toolCalls;
  }

  get queue(): AngularQueueInterface<{
    entries: readonly { id: string; values: Partial<T> | null | undefined }[];
    size: number;
    cancel: (id: string) => Promise<boolean>;
    clear: () => Promise<void>;
  }> {
    return this._stream.queue;
  }

  get subagents(): Signal<ReadonlyMap<string, SubagentStreamInterface>> {
    return this._stream.subagents;
  }

  get activeSubagents(): Signal<readonly SubagentStreamInterface[]> {
    return this._stream.activeSubagents;
  }

  get history(): Signal<unknown> {
    return this._stream.history;
  }

  get isThreadLoading(): Signal<boolean> {
    return this._stream.isThreadLoading;
  }

  get experimental_branchTree(): Signal<unknown> {
    return this._stream.experimental_branchTree;
  }

  get client(): Client {
    return this._stream.client;
  }

  get assistantId(): string {
    return this._stream.assistantId;
  }

  submit(
    values: AcceptBaseMessages<Exclude<T, null | undefined>> | null | undefined,
    options?: SubmitOptions<
      T extends Record<string, unknown> ? T : Record<string, unknown>,
      GetConfigurableType<Bag>
    >
  ): ReturnType<typeof this._stream.submit> {
    return this._stream.submit(values, options);
  }

  async stop(): Promise<void> {
    await this._stream.stop();
  }

  setBranch(value: string): void {
    this._stream.setBranch(value);
  }

  switchThread(newThreadId: string | null): void {
    this._stream.switchThread(newThreadId);
  }

  joinStream(
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
  ): Promise<void> {
    return this._stream.joinStream(runId, lastEventId, options);
  }

  getMessagesMetadata(
    message: BaseMessage,
    index?: number
  ):
    | MessageMetadata<
        T extends Record<string, unknown> ? T : Record<string, unknown>
      >
    | undefined {
    return this._stream.getMessagesMetadata(message as Message, index);
  }

  getToolCalls(message: BaseMessage): SdkToolCallWithResult<DefaultToolCall>[] {
    return this._stream.getToolCalls(message as Message);
  }

  getSubagent(toolCallId: string): SubagentStreamInterface | undefined {
    return this._stream.getSubagent(toolCallId);
  }

  getSubagentsByType(type: string): SubagentStreamInterface[] {
    return this._stream.getSubagentsByType(type);
  }

  getSubagentsByMessage(messageId: string): SubagentStreamInterface[] {
    return this._stream.getSubagentsByMessage(messageId);
  }
}

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
  SubagentApi,
  SubagentStream,
  SubagentStreamInterface,
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
  QueueEntry,
  QueueInterface,
} from "@langchain/langgraph-sdk/ui";

export type ToolCallWithResult<ToolCall = DefaultToolCall> =
  SdkToolCallWithResult<ToolCall, CoreToolMessage, CoreAIMessage>;
export type {
  ToolCallState,
  DefaultToolCall,
  ToolCallFromTool,
  ToolCallsFromTools,
} from "@langchain/langgraph-sdk";
export type {
  HeadlessToolImplementation,
  AnyHeadlessToolImplementation,
  ToolEvent,
  HeadlessToolInterrupt,
  OnToolCallback,
  FlushPendingHeadlessToolInterruptsOptions,
} from "@langchain/langgraph-sdk";

export {
  SubagentManager,
  extractToolCallIdFromNamespace,
  calculateDepthFromNamespace,
  extractParentIdFromNamespace,
  isSubagentNamespace,
} from "@langchain/langgraph-sdk/ui";
export {
  isHeadlessToolInterrupt,
  parseHeadlessToolInterruptPayload,
  filterOutHeadlessToolInterrupts,
  findHeadlessTool,
  executeHeadlessTool,
  handleHeadlessToolInterrupt,
  headlessToolResumeCommand,
  flushPendingHeadlessToolInterrupts,
} from "@langchain/langgraph-sdk";
