import {
  signal,
  computed,
  effect,
  Injectable,
  inject as angularInject,
} from "@angular/core";
import type { Signal, WritableSignal } from "@angular/core";
import type {
  BaseMessage,
  ToolMessage as CoreToolMessage,
  AIMessage as CoreAIMessage,
} from "@langchain/core/messages";
import {
  StreamManager,
  MessageTupleManager,
  PendingRunsTracker,
  filterStream,
  getBranchContext,
  getMessagesMetadataMap,
  StreamError,
  extractInterrupts,
  toMessageClass,
  ensureMessageInstances,
  ensureHistoryMessageInstances,
  type UseStreamThread,
  type GetConfigurableType,
  type GetCustomEventType,
  type GetInterruptType,
  type GetUpdateType,
  type MessageMetadata,
  type AnyStreamOptions,
  type SubmitOptions,
  type EventStreamEvent,
  type RunCallbackMeta,
  type ResolveStreamOptions,
  type ResolveStreamInterface,
  type InferBag,
  type InferStateType,
  type AcceptBaseMessages,
  type UseStreamCustomOptions,
  type SubagentStreamInterface,
  type HistoryWithBaseMessages,
} from "@langchain/langgraph-sdk/ui";

import {
  Client,
  type StreamEvent,
  type StreamMode,
  type Message,
  type Interrupt,
  type BagTemplate,
  type ThreadState,
  type ToolCallWithResult as _ToolCallWithResult,
  type DefaultToolCall,
} from "@langchain/langgraph-sdk";
import { getToolCallsWithResults } from "@langchain/langgraph-sdk/utils";
import { injectStreamCustom } from "./stream.custom.js";
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

type ClassToolCallWithResult<T> =
  T extends _ToolCallWithResult<infer TC, unknown, unknown>
    ? _ToolCallWithResult<TC, CoreToolMessage, CoreAIMessage>
    : T;

export type ClassSubagentStreamInterface<
  StateType = Record<string, unknown>,
  ToolCall = DefaultToolCall,
  SubagentName extends string = string,
> = Omit<
  SubagentStreamInterface<StateType, ToolCall, SubagentName>,
  "messages"
> & {
  messages: BaseMessage[];
};

type WithClassMessages<T> = Omit<
  T,
  | "messages"
  | "history"
  | "getMessagesMetadata"
  | "toolCalls"
  | "getToolCalls"
  | "submit"
  | "subagents"
  | "activeSubagents"
  | "getSubagent"
  | "getSubagentsByType"
  | "getSubagentsByMessage"
> & {
  messages: BaseMessage[];
  getMessagesMetadata: (
    message: BaseMessage,
    index?: number,
  ) => MessageMetadata<Record<string, unknown>> | undefined;
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
              options?: O,
            ) => Ret
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
            id: string,
          ) => SubagentStreamInterface<infer S, infer TC, infer N> | undefined;
        }
          ? (
              toolCallId: string,
            ) => ClassSubagentStreamInterface<S, TC, N> | undefined
          : never;
        getSubagentsByType: T extends {
          getSubagentsByType: (
            type: string,
          ) => SubagentStreamInterface<infer S, infer TC, infer N>[];
        }
          ? (type: string) => ClassSubagentStreamInterface<S, TC, N>[]
          : never;
        getSubagentsByMessage: T extends {
          getSubagentsByMessage: (
            id: string,
          ) => SubagentStreamInterface<infer S, infer TC, infer N>[];
        }
          ? (messageId: string) => ClassSubagentStreamInterface<S, TC, N>[]
          : never;
      }
    : unknown);

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
  | "subagents"
  | "activeSubagents"
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

function fetchHistory<StateType extends Record<string, unknown>>(
  client: Client,
  threadId: string,
  options?: { limit?: boolean | number },
) {
  if (options?.limit === false) {
    return client.threads.getState<StateType>(threadId).then((state) => {
      if (state.checkpoint == null) return [];
      return [state];
    });
  }

  const limit = typeof options?.limit === "number" ? options.limit : 10;
  return client.threads.getHistory<StateType>(threadId, { limit });
}

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
  options: ResolveStreamOptions<T, InferBag<T, Bag>>,
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
  options: UseStreamCustomOptions<InferStateType<T>, InferBag<T, Bag>>,
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
          "or use useStream() directly.",
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

function resolveRunMetadataStorage(
  reconnectOnMount: AnyStreamOptions["reconnectOnMount"],
) {
  if (typeof globalThis.window === "undefined") return null;
  if (reconnectOnMount === true) return globalThis.window.sessionStorage;
  if (typeof reconnectOnMount === "function") return reconnectOnMount();
  return null;
}

export function useStreamLGP<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends {
    ConfigurableType?: Record<string, unknown>;
    InterruptType?: unknown;
    CustomEventType?: unknown;
    UpdateType?: unknown;
  } = BagTemplate,
>(options: AnyStreamOptions<StateType, Bag>) {
  type UpdateType = GetUpdateType<Bag, StateType>;
  type CustomType = GetCustomEventType<Bag>;
  type InterruptType = GetInterruptType<Bag>;
  type ConfigurableType = GetConfigurableType<Bag>;

  const runMetadataStorage = resolveRunMetadataStorage(
    options.reconnectOnMount,
  );

  const getMessages = (value: StateType): Message[] => {
    const messagesKey = options.messagesKey ?? "messages";
    return Array.isArray(value[messagesKey]) ? value[messagesKey] : [];
  };

  const setMessages = (current: StateType, messages: Message[]): StateType => {
    const messagesKey = options.messagesKey ?? "messages";
    return { ...current, [messagesKey]: messages };
  };

  const historyLimit =
    typeof options.fetchStateHistory === "object" &&
    options.fetchStateHistory != null
      ? (options.fetchStateHistory.limit ?? false)
      : (options.fetchStateHistory ?? false);

  const threadId = signal<string | undefined>(undefined);
  let threadIdPromise: Promise<string> | null = null;

  const client = options.client ?? new Client({ apiUrl: options.apiUrl });

  const history = signal<UseStreamThread<StateType>>({
    data: undefined,
    error: undefined,
    isLoading: false,
    mutate: async () => undefined,
  });

  async function mutate(
    mutateId?: string,
  ): Promise<ThreadState<StateType>[] | undefined> {
    const tid = mutateId ?? threadId();
    if (!tid) return undefined;
    try {
      const data = await fetchHistory<StateType>(client, tid, {
        limit: historyLimit,
      });
      history.set({
        data,
        error: undefined,
        isLoading: false,
        mutate,
      });
      return data;
    } catch (err) {
      history.update((prev) => ({
        ...prev,
        error: err,
        isLoading: false,
      }));
      options.onError?.(err, undefined);
      return undefined;
    }
  }

  history.update((prev) => ({ ...prev, mutate }));

  const branch = signal<string>("");
  const branchContext = computed(() =>
    getBranchContext(branch(), history().data ?? undefined),
  );

  const messageManager = new MessageTupleManager();
  const stream = new StreamManager<StateType, Bag>(messageManager, {
    throttle: options.throttle ?? false,
    subagentToolNames: options.subagentToolNames,
    filterSubagentMessages: options.filterSubagentMessages,
    toMessage: toMessageClass,
  });

  const pendingRuns = new PendingRunsTracker<
    StateType,
    SubmitOptions<StateType, ConfigurableType>
  >();
  const queueEntries = signal(pendingRuns.entries);
  const queueSize = signal(pendingRuns.size);

  const historyValues = computed(
    () =>
      branchContext().threadHead?.values ??
      options.initialValues ??
      ({} as StateType),
  );

  const historyError = computed(() => {
    const error = branchContext().threadHead?.tasks?.at(-1)?.error;
    if (error == null) return undefined;
    try {
      const parsed = JSON.parse(error) as unknown;
      if (StreamError.isStructuredError(parsed)) return new StreamError(parsed);
      return parsed;
    } catch {
      // do nothing
    }
    return error;
  });

  const streamValues = signal<StateType | null>(stream.values);
  const streamError = signal<unknown>(stream.error);
  const isLoading = signal(stream.isLoading);

  const values = computed(() => streamValues() ?? historyValues());
  const error = computed(
    () => streamError() ?? historyError() ?? history().error,
  );

  const messageMetadata = computed(() =>
    getMessagesMetadataMap({
      initialValues: options.initialValues,
      history: history().data,
      getMessages,
      branchContext: branchContext(),
    }),
  );

  const subagentVersion = signal(0);

  effect((onCleanup) => {
    const unsubscribe = stream.subscribe(() => {
      streamValues.set(stream.values);
      streamError.set(stream.error);
      isLoading.set(stream.isLoading);
      subagentVersion.update((v) => v + 1);
    });

    onCleanup(() => unsubscribe());
  });

  pendingRuns.subscribe(() => {
    queueEntries.set(pendingRuns.entries);
    queueSize.set(pendingRuns.size);
  });

  effect((onCleanup) => {
    const hvMessages = getMessages(historyValues());
    const should =
      options.filterSubagentMessages &&
      !isLoading() &&
      !history().isLoading &&
      hvMessages.length > 0;
    if (should) {
      stream.reconstructSubagents(hvMessages, { skipIfPopulated: true });
      // Fetch internal messages for each subagent from their subgraph checkpoints.
      // These messages are not in the main thread state but are persisted in the
      // checkpointer under a subgraph-specific checkpoint_ns (e.g. tools:call_abc123).
      const tid = threadId();
      if (tid) {
        const controller = new AbortController();
        void stream.fetchSubagentHistory(client.threads, tid, {
          messagesKey: options.messagesKey ?? "messages",
          signal: controller.signal,
        });
        onCleanup(() => controller.abort());
      }
    }
  });

  function stop() {
    return stream.stop(historyValues(), {
      onStop: (args) => {
        if (runMetadataStorage && threadId()) {
          const tid = threadId()!;
          const runId = runMetadataStorage.getItem(`lg:stream:${tid}`);
          if (runId) void client.runs.cancel(tid, runId);
          runMetadataStorage.removeItem(`lg:stream:${tid}`);
        }

        options.onStop?.(args);
      },
    });
  }

  function setBranch(value: string) {
    branch.set(value);
  }

  function submitDirect(
    values: StateType,
    submitOptions?: SubmitOptions<StateType, ConfigurableType>,
  ) {
    const currentBranchContext = branchContext();

    const checkpointId = submitOptions?.checkpoint?.checkpoint_id;
    branch.set(
      checkpointId != null
        ? (currentBranchContext.branchByCheckpoint[checkpointId]?.branch ?? "")
        : "",
    );

    const includeImplicitBranch =
      historyLimit === true || typeof historyLimit === "number";

    const shouldRefetch = options.onFinish != null || includeImplicitBranch;

    let checkpoint =
      submitOptions?.checkpoint ??
      (includeImplicitBranch
        ? currentBranchContext.threadHead?.checkpoint
        : undefined) ??
      undefined;

    if (submitOptions?.checkpoint === null) checkpoint = undefined;
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    if (checkpoint != null) delete checkpoint.thread_id;

    const streamResumable =
      submitOptions?.streamResumable ?? !!runMetadataStorage;

    let callbackMeta: RunCallbackMeta | undefined;
    let rejoinKey: `lg:stream:${string}` | undefined;
    let usableThreadId: string | undefined;

    return stream.start(
      async (signal) => {
        usableThreadId = threadId();
        if (!usableThreadId) {
          const threadPromise = client.threads.create({
            threadId: submitOptions?.threadId,
            metadata: submitOptions?.metadata,
          });

          threadIdPromise = threadPromise.then((t) => t.thread_id);

          const thread = await threadPromise;

          usableThreadId = thread.thread_id;
          threadId.set(usableThreadId);
          options.onThreadId?.(usableThreadId);
        }

        const streamMode = new Set<StreamMode>([
          ...(submitOptions?.streamMode ?? []),
          "values",
          "messages-tuple",
          "updates",
        ]);
        if (options.onUpdateEvent) streamMode.add("updates");
        if (options.onCustomEvent) streamMode.add("custom");
        if (options.onCheckpointEvent) streamMode.add("checkpoints");
        if (options.onTaskEvent) streamMode.add("tasks");
        if ("onDebugEvent" in options && options.onDebugEvent)
          streamMode.add("debug");
        if ("onLangChainEvent" in options && options.onLangChainEvent)
          streamMode.add("events");

        stream.setStreamValues(() => {
          const prev = { ...historyValues(), ...stream.values };

          if (submitOptions?.optimisticValues != null) {
            return {
              ...prev,
              ...(typeof submitOptions.optimisticValues === "function"
                ? submitOptions.optimisticValues(prev)
                : submitOptions.optimisticValues),
            };
          }

          return { ...prev };
        });

        return client.runs.stream(usableThreadId!, options.assistantId, {
          input: values as Record<string, unknown>,
          config: submitOptions?.config,
          context: submitOptions?.context,
          command: submitOptions?.command,

          interruptBefore: submitOptions?.interruptBefore,
          interruptAfter: submitOptions?.interruptAfter,
          metadata: submitOptions?.metadata,
          multitaskStrategy: submitOptions?.multitaskStrategy,
          onCompletion: submitOptions?.onCompletion,
          onDisconnect:
            submitOptions?.onDisconnect ??
            (streamResumable ? "continue" : "cancel"),

          signal,

          checkpoint,
          streamMode: [...streamMode],
          streamSubgraphs: submitOptions?.streamSubgraphs,
          streamResumable,
          durability: submitOptions?.durability,
          onRunCreated(params) {
            callbackMeta = {
              run_id: params.run_id,
              thread_id: params.thread_id ?? usableThreadId!,
            };

            if (runMetadataStorage) {
              rejoinKey = `lg:stream:${usableThreadId}`;
              runMetadataStorage.setItem(rejoinKey, callbackMeta.run_id);
            }

            options.onCreated?.(callbackMeta);
          },
        }) as AsyncGenerator<
          EventStreamEvent<StateType, UpdateType, CustomType>
        >;
      },
      {
        getMessages,
        setMessages,

        initialValues: historyValues(),
        callbacks: options,

        async onSuccess() {
          if (rejoinKey) runMetadataStorage?.removeItem(rejoinKey);

          if (shouldRefetch && usableThreadId) {
            const newHistory = await mutate(usableThreadId);
            const lastHead = newHistory?.at(0);
            if (lastHead) {
              options.onFinish?.(lastHead, callbackMeta);
              return null;
            }
          }
          return undefined;
        },
        onError: (error) => {
          options.onError?.(error, callbackMeta);
          submitOptions?.onError?.(error, callbackMeta);
        },
        onFinish: () => {},
      },
    );
  }

  let submitting = false;

  function drainQueue() {
    if (!isLoading() && !submitting && pendingRuns.size > 0) {
      const next = pendingRuns.shift();
      if (next) {
        submitting = true;
        void joinStream(next.id).finally(() => {
          submitting = false;
          drainQueue();
        });
      }
    }
  }

  effect(() => {
    drainQueue();
  });

  async function submit(
    values: StateType,
    submitOptions?: SubmitOptions<StateType, ConfigurableType>,
  ) {
    if (stream.isLoading || submitting) {
      const shouldAbort =
        submitOptions?.multitaskStrategy === "interrupt" ||
        submitOptions?.multitaskStrategy === "rollback";

      if (shouldAbort) {
        submitting = true;
        try {
          await submitDirect(values, submitOptions);
        } finally {
          submitting = false;
        }
        return;
      }

      let usableThreadId: string | undefined = threadId();
      if (!usableThreadId && threadIdPromise) {
        usableThreadId = await threadIdPromise;
      }
      if (usableThreadId) {
        try {
          const run = await client.runs.create(
            usableThreadId,
            options.assistantId,
            {
              input: values as Record<string, unknown>,
              config: submitOptions?.config,
              context: submitOptions?.context,
              command: submitOptions?.command,
              interruptBefore: submitOptions?.interruptBefore,
              interruptAfter: submitOptions?.interruptAfter,
              metadata: submitOptions?.metadata,
              multitaskStrategy: "enqueue",
              streamResumable: true,
              streamSubgraphs: submitOptions?.streamSubgraphs,
              durability: submitOptions?.durability,
            },
          );

          pendingRuns.add({
            id: run.run_id,
            values: values as Partial<StateType> | null | undefined,
            options: submitOptions,
            createdAt: new Date(run.created_at),
          });
        } catch (error) {
          options.onError?.(error, undefined);
          submitOptions?.onError?.(error, undefined);
        }
        return;
      }
    }

    submitting = true;
    const result = submitDirect(values, submitOptions);
    void Promise.resolve(result).finally(() => {
      submitting = false;
      drainQueue();
    });
    return result;
  }

  async function joinStream(
    runId: string,
    lastEventId?: string,
    joinOptions?: {
      streamMode?: StreamMode | StreamMode[];
      filter?: (event: {
        id?: string;
        event: StreamEvent;
        data: unknown;
      }) => boolean;
    },
  ) {
    // eslint-disable-next-line no-param-reassign
    lastEventId ??= "-1";
    const tid = threadId();
    if (!tid) return;

    const callbackMeta: RunCallbackMeta = {
      thread_id: tid,
      run_id: runId,
    };

    await stream.start(
      async (signal: AbortSignal) => {
        const rawStream = client.runs.joinStream(tid, runId, {
          signal,
          lastEventId,
          streamMode: joinOptions?.streamMode,
        }) as AsyncGenerator<
          EventStreamEvent<StateType, UpdateType, CustomType>
        >;

        return joinOptions?.filter != null
          ? filterStream(rawStream, joinOptions.filter)
          : rawStream;
      },
      {
        getMessages,
        setMessages,

        initialValues: historyValues(),
        callbacks: options,
        async onSuccess() {
          runMetadataStorage?.removeItem(`lg:stream:${tid}`);
          const newHistory = await mutate(tid);
          const lastHead = newHistory?.at(0);
          if (lastHead) options.onFinish?.(lastHead, callbackMeta);
        },
        onError(error) {
          options.onError?.(error, callbackMeta);
        },
        onFinish() {},
      },
    );
  }

  const shouldReconnect = !!runMetadataStorage;
  let hasReconnected = false;

  effect(() => {
    const tid = threadId();
    if (
      !hasReconnected &&
      shouldReconnect &&
      runMetadataStorage &&
      tid &&
      !isLoading()
    ) {
      const runId = runMetadataStorage.getItem(`lg:stream:${tid}`);
      if (runId) {
        hasReconnected = true;
        void joinStream(runId);
      }
    }
  });

  const messages = computed(() =>
    ensureMessageInstances(getMessages(values())),
  );

  const toolCalls = computed(() =>
    getToolCallsWithResults(getMessages(values())),
  );

  function getToolCalls(message: Message) {
    const allToolCalls = getToolCallsWithResults(getMessages(values()));
    return allToolCalls.filter((tc) => tc.aiMessage.id === message.id);
  }

  const interrupt = computed(() =>
    extractInterrupts<InterruptType>(values(), {
      isLoading: isLoading(),
      threadState: branchContext().threadHead,
      error: error(),
    }),
  );

  const interrupts = computed((): Interrupt<InterruptType>[] => {
    const vals = values();
    if (
      vals != null &&
      "__interrupt__" in vals &&
      Array.isArray(vals.__interrupt__)
    ) {
      const valueInterrupts = vals.__interrupt__;
      if (valueInterrupts.length === 0) return [{ when: "breakpoint" }];
      return valueInterrupts;
    }

    if (isLoading()) return [];

    const allTasks = branchContext().threadHead?.tasks ?? [];
    const allInterrupts = allTasks.flatMap((t) => t.interrupts ?? []);

    if (allInterrupts.length > 0) {
      return allInterrupts as Interrupt<InterruptType>[];
    }

    const next = branchContext().threadHead?.next ?? [];
    if (!next.length || error() != null) return [];
    return [{ when: "breakpoint" }];
  });

  const historyList = computed(() => {
    if (historyLimit === false) {
      throw new Error(
        "`fetchStateHistory` must be set to `true` to use `history`",
      );
    }
    return ensureHistoryMessageInstances(
      branchContext().flatHistory,
      options.messagesKey ?? "messages",
    );
  });

  const isThreadLoading = computed(
    () => history().isLoading && history().data == null,
  );

  const experimentalBranchTree = computed(() => {
    if (historyLimit === false) {
      throw new Error(
        "`fetchStateHistory` must be set to `true` to use `experimental_branchTree`",
      );
    }
    return branchContext().branchTree;
  });

  function getMessagesMetadata(
    message: Message,
    index?: number,
  ): MessageMetadata<StateType> | undefined {
    const streamMetadata = messageManager.get(message.id)?.metadata;
    const historyMetadata = messageMetadata().find(
      (m) => m.messageId === (message.id ?? index),
    );

    if (streamMetadata != null || historyMetadata != null) {
      return {
        ...historyMetadata,
        streamMetadata,
      } as MessageMetadata<StateType>;
    }

    return undefined;
  }

  return {
    assistantId: options.assistantId,
    client,

    values,
    error,
    isLoading,

    branch,
    setBranch,

    messages,
    toolCalls,
    getToolCalls,

    interrupt,
    interrupts,

    history: historyList,
    isThreadLoading,
    experimental_branchTree: experimentalBranchTree,

    getMessagesMetadata,

    submit,
    stop,
    joinStream,

    queue: {
      entries: queueEntries,
      size: queueSize,
      async cancel(id: string) {
        const tid = threadId();
        const removed = pendingRuns.remove(id);
        if (removed && tid) {
          await client.runs.cancel(tid, id);
        }
        return removed;
      },
      async clear() {
        const tid = threadId();
        const removed = pendingRuns.removeAll();
        if (tid && removed.length > 0) {
          await Promise.all(removed.map((e) => client.runs.cancel(tid!, e.id)));
        }
      },
    },

    switchThread(newThreadId: string | null) {
      const current = threadId() ?? null;
      if (newThreadId !== current) {
        const prevThreadId = threadId();
        threadId.set(newThreadId ?? undefined);
        stream.clear();

        const removed = pendingRuns.removeAll();
        if (prevThreadId && removed.length > 0) {
          void Promise.all(
            removed.map((e) => client.runs.cancel(prevThreadId, e.id)),
          );
        }

        if (newThreadId != null) {
          options.onThreadId?.(newThreadId);
        }
      }
    },

    get subagents() {
      void subagentVersion();
      return stream.getSubagents();
    },
    get activeSubagents() {
      void subagentVersion();
      return stream.getActiveSubagents();
    },
    getSubagent(toolCallId: string) {
      return stream.getSubagent(toolCallId);
    },
    getSubagentsByType(type: string) {
      return stream.getSubagentsByType(type);
    },
    getSubagentsByMessage(messageId: string) {
      return stream.getSubagentsByMessage(messageId);
    },
  };
}

/**
 * Internal interface describing the shape returned by {@link useStream}
 * after `AngularSignalWrap` and `WithClassMessages` transformations.
 *
 * Defined explicitly (rather than derived from `ResolveStreamInterface`)
 * because the latter is a conditional type that TypeScript cannot resolve
 * when `T` is still a generic parameter.
 */
interface StreamServiceInstance<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
> {
  values: Signal<T>;
  messages: Signal<BaseMessage[]>;
  isLoading: WritableSignal<boolean>;
  error: Signal<unknown>;
  branch: WritableSignal<string>;
  interrupt: Signal<Interrupt<GetInterruptType<Bag>> | undefined>;
  interrupts: Signal<Interrupt<GetInterruptType<Bag>>[]>;
  toolCalls: Signal<
    _ToolCallWithResult<DefaultToolCall, CoreToolMessage, CoreAIMessage>[]
  >;
  queue: AngularQueueInterface<{
    entries: readonly {
      id: string;
      values: Partial<T> | null | undefined;
    }[];
    size: number;
    cancel: (id: string) => Promise<boolean>;
    clear: () => Promise<void>;
  }>;
  subagents: Map<string, ClassSubagentStreamInterface>;
  activeSubagents: ClassSubagentStreamInterface[];
  history: Signal<unknown>;
  isThreadLoading: Signal<boolean>;
  experimental_branchTree: Signal<unknown>;
  client: Client;
  assistantId: string;
  submit(
    values:
      | AcceptBaseMessages<Exclude<T, null | undefined>>
      | null
      | undefined,
    options?: SubmitOptions<
      T extends Record<string, unknown> ? T : Record<string, unknown>,
      GetConfigurableType<Bag>
    >,
  ): Promise<void>;
  stop(): Promise<void>;
  setBranch(value: string): void;
  switchThread(newThreadId: string | null): void;
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
    },
  ): Promise<void>;
  getMessagesMetadata(
    message: BaseMessage,
    index?: number,
  ):
    | MessageMetadata<
        T extends Record<string, unknown> ? T : Record<string, unknown>
      >
    | undefined;
  getToolCalls(
    message: BaseMessage,
  ): _ToolCallWithResult<DefaultToolCall, CoreToolMessage, CoreAIMessage>[];
  getSubagent(
    toolCallId: string,
  ): ClassSubagentStreamInterface | undefined;
  getSubagentsByType(type: string): ClassSubagentStreamInterface[];
  getSubagentsByMessage(messageId: string): ClassSubagentStreamInterface[];
}

/**
 * Injectable Angular service that wraps {@link useStream}.
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
 * The service exposes the same signals and methods as `useStream`
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
      | UseStreamCustomOptions<InferStateType<T>, InferBag<T, Bag>>,
  ) {
    // The union of option types doesn't match either useStream overload
    // directly, so we cast the argument. The result is typed via
    // StreamServiceInstance which captures the post-transformation shape.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this._stream = useStream(options as any);
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

  get toolCalls(): Signal<
    _ToolCallWithResult<DefaultToolCall, CoreToolMessage, CoreAIMessage>[]
  > {
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

  get subagents(): Map<string, ClassSubagentStreamInterface> {
    return this._stream.subagents;
  }

  get activeSubagents(): ClassSubagentStreamInterface[] {
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
    >,
  ): Promise<void> {
    return this._stream.submit(values, options);
  }

  stop(): Promise<void> {
    return this._stream.stop();
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
    },
  ): Promise<void> {
    return this._stream.joinStream(runId, lastEventId, options);
  }

  getMessagesMetadata(
    message: BaseMessage,
    index?: number,
  ):
    | MessageMetadata<
        T extends Record<string, unknown> ? T : Record<string, unknown>
      >
    | undefined {
    return this._stream.getMessagesMetadata(message, index);
  }

  getToolCalls(
    message: BaseMessage,
  ): _ToolCallWithResult<DefaultToolCall, CoreToolMessage, CoreAIMessage>[] {
    return this._stream.getToolCalls(message);
  }

  getSubagent(toolCallId: string): ClassSubagentStreamInterface | undefined {
    return this._stream.getSubagent(toolCallId);
  }

  getSubagentsByType(type: string): ClassSubagentStreamInterface[] {
    return this._stream.getSubagentsByType(type);
  }

  getSubagentsByMessage(messageId: string): ClassSubagentStreamInterface[] {
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
  _ToolCallWithResult<ToolCall, CoreToolMessage, CoreAIMessage>;
export type {
  ToolCallState,
  DefaultToolCall,
  ToolCallFromTool,
  ToolCallsFromTools,
} from "@langchain/langgraph-sdk";

export {
  SubagentManager,
  extractToolCallIdFromNamespace,
  calculateDepthFromNamespace,
  extractParentIdFromNamespace,
  isSubagentNamespace,
} from "@langchain/langgraph-sdk/ui";
