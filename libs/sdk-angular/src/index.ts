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
  StreamOrchestrator,
  ensureMessageInstances,
  type MessageMetadata,
  type AnyStreamOptions,
  type SubmitOptions,
  type ResolveStreamOptions,
  type ResolveStreamInterface,
  type InferBag,
  type InferStateType,
  type AcceptBaseMessages,
  type UseStreamCustomOptions,
  type SubagentStreamInterface,
  type HistoryWithBaseMessages,
  type GetConfigurableType,
  type GetInterruptType,
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
import type { ClassSubagentStreamInterface } from "./subagent-types.js";
import type { StreamServiceInstance } from "./stream-service-instance.js";
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
export type { ClassSubagentStreamInterface } from "./subagent-types.js";

type ClassToolCallWithResult<T> =
  T extends SdkToolCallWithResult<infer TC, unknown, unknown>
    ? SdkToolCallWithResult<TC, CoreToolMessage, CoreAIMessage>
    : T;

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

/**
 * Injects the shared stream instance from the nearest ancestor that provided
 * one via {@link provideStream}. Throws if no ancestor provides a stream
 * instance.
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
 * Overload for a **custom transport** (`options.transport`).
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
          "or use injectStream(options) directly.",
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

export function useStreamLGP<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends {
    ConfigurableType?: Record<string, unknown>;
    InterruptType?: unknown;
    CustomEventType?: unknown;
    UpdateType?: unknown;
  } = BagTemplate,
>(options: AnyStreamOptions<StateType, Bag>) {
  type ConfigurableType = GetConfigurableType<Bag>;
  type InterruptType = GetInterruptType<Bag>;

  const client = options.client ?? new Client({ apiUrl: options.apiUrl });

  const orchestrator = new StreamOrchestrator<StateType, Bag>(options, {
    getClient: () => client,
    getAssistantId: () => options.assistantId,
    getMessagesKey: () => options.messagesKey ?? "messages",
  });

  orchestrator.initThreadId(options.threadId ?? undefined);

  const version = signal(0);
  const subagentVersion = signal(0);

  effect((onCleanup) => {
    const unsubscribe = orchestrator.subscribe(() => {
      version.update((v) => v + 1);
      subagentVersion.update((v) => v + 1);
    });
    onCleanup(() => unsubscribe());
  });

  // Subagent reconstruction
  effect((onCleanup) => {
    void version();
    const hvMessages = orchestrator.messages;
    const should =
      options.filterSubagentMessages &&
      !orchestrator.isLoading &&
      !orchestrator.historyData.isLoading &&
      hvMessages.length > 0;
    if (should) {
      const controller = orchestrator.reconstructSubagentsIfNeeded();
      if (controller) {
        onCleanup(() => controller.abort());
      }
    }
  });

  // Queue draining
  effect(() => {
    void version();
    orchestrator.drainQueue();
  });

  // Auto-reconnect
  const shouldReconnect = orchestrator.shouldReconnect;
  let hasReconnected = false;

  effect(() => {
    void version();
    const tid = orchestrator.threadId;
    if (
      !hasReconnected &&
      shouldReconnect &&
      tid &&
      !orchestrator.isLoading
    ) {
      const reconnected = orchestrator.tryReconnect();
      if (reconnected) hasReconnected = true;
    }
  });

  const values = computed(() => {
    void version();
    return orchestrator.values;
  });

  const error = computed(() => {
    void version();
    return orchestrator.error;
  });

  const isLoading = signal(orchestrator.isLoading);
  effect(() => {
    void version();
    isLoading.set(orchestrator.isLoading);
  });

  const branch = signal<string>("");
  effect(() => {
    void version();
    const b = orchestrator.branch;
    if (branch() !== b) branch.set(b);
  });

  const messages = computed(() => {
    void version();
    return ensureMessageInstances(orchestrator.messages);
  });

  const toolCalls = computed(() => {
    void version();
    return orchestrator.toolCalls;
  });

  const interrupt = computed(() => {
    void version();
    return orchestrator.interrupt;
  });

  const interrupts = computed((): Interrupt<InterruptType>[] => {
    void version();
    return orchestrator.interrupts as Interrupt<InterruptType>[];
  });

  const historyList = computed(() => {
    void version();
    return orchestrator.flatHistory;
  });

  const isThreadLoading = computed(() => {
    void version();
    return orchestrator.isThreadLoading;
  });

  const experimentalBranchTree = computed(() => {
    void version();
    return orchestrator.experimental_branchTree;
  });

  const queueEntries = signal(orchestrator.queueEntries);
  const queueSize = signal(orchestrator.queueSize);
  effect(() => {
    void version();
    queueEntries.set(orchestrator.queueEntries);
    queueSize.set(orchestrator.queueSize);
  });

  return {
    assistantId: options.assistantId,
    client,

    values,
    error,
    isLoading,

    branch,
    setBranch: orchestrator.setBranch,

    messages,
    toolCalls,
    getToolCalls(message: Message) {
      return orchestrator.getToolCalls(message);
    },

    interrupt,
    interrupts,

    history: historyList,
    isThreadLoading,
    experimental_branchTree: experimentalBranchTree,

    getMessagesMetadata(
      message: Message,
      index?: number,
    ): MessageMetadata<StateType> | undefined {
      return orchestrator.getMessagesMetadata(message, index);
    },

    submit: orchestrator.submit as (
      values: StateType,
      submitOptions?: SubmitOptions<StateType, ConfigurableType>,
    ) => Promise<void>,
    stop: orchestrator.stop,
    joinStream: orchestrator.joinStream,

    queue: {
      entries: queueEntries,
      size: queueSize,
      cancel: orchestrator.cancelQueueItem,
      clear: orchestrator.clearQueue,
    },

    switchThread: orchestrator.switchThread,

    get subagents() {
      void subagentVersion();
      return orchestrator.subagents;
    },
    get activeSubagents() {
      void subagentVersion();
      return orchestrator.activeSubagents;
    },
    getSubagent: orchestrator.getSubagent,
    getSubagentsByType: orchestrator.getSubagentsByType,
    getSubagentsByMessage: orchestrator.getSubagentsByMessage,
  };
}

/**
 * Injectable Angular service that wraps {@link injectStream}.
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this._stream = injectStream(options as any) as unknown as StreamServiceInstance<T, Bag>;
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

  get subagents(): Map<string, SubagentStreamInterface> {
    return this._stream.subagents;
  }

  get activeSubagents(): SubagentStreamInterface[] {
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
  ): ReturnType<typeof this._stream.submit> {
    return this._stream.submit(values, options);
  }

  stop(): void {
    void this._stream.stop();
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
    message: Message,
    index?: number,
  ):
    | MessageMetadata<
        T extends Record<string, unknown> ? T : Record<string, unknown>
      >
    | undefined {
    return this._stream.getMessagesMetadata(message, index);
  }

  getToolCalls(
    message: Message,
  ): SdkToolCallWithResult<DefaultToolCall>[] {
    return this._stream.getToolCalls(message);
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

export {
  SubagentManager,
  extractToolCallIdFromNamespace,
  calculateDepthFromNamespace,
  extractParentIdFromNamespace,
  isSubagentNamespace,
} from "@langchain/langgraph-sdk/ui";
