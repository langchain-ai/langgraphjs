import type {
  AnyHeadlessToolImplementation,
  Client,
  ClientConfig,
  Command,
  Message,
  OnToolCallback,
} from "@langchain/langgraph-sdk";
import type {
  MessageMetadataMap,
  RunEndReason,
  StreamOrchestratorOptions,
  UseStreamTransport,
} from "@langchain/langgraph-sdk/ui";

/** Why a run's stream ended. */
export type RunExecutionReason = RunEndReason;

/** Passed to `onCreated` once the server accepts a run this hook started. */
export interface RunExecutionInfo {
  runId: string;
}

/** Passed to `onCompleted` when the stream of a run ends. */
export interface RunCompletedInfo {
  runId?: string;
  reason: RunExecutionReason;
}

/** Options shared by every `useStream` call. */
export interface UseStreamCommonOptions<
  StateType extends object,
  ThreadIdType = string | null,
> {
  /**
   * The thread to show. An id the server doesn't know yet shows an empty
   * thread, and the first submit creates it.
   */
  threadId?: ThreadIdType;
  /** Called with the id of each thread the stream moves to, including one its submit created. */
  onThreadId?: (threadId: string) => void;
  /** Called once the server accepts a run this hook started. */
  onCreated?: (info: RunExecutionInfo) => void;
  /** Called when the stream of a run ends, with the reason. */
  onCompleted?: (info: RunCompletedInfo) => void;
  /** Values to show before the thread's state is read. */
  initialValues?: StateType;
  /** State key holding the message array. Defaults to `"messages"`. */
  messagesKey?: string;
  /** Headless tool implementations, run when the agent interrupts to call one. */
  tools?: AnyHeadlessToolImplementation[];
  /** Called with the lifecycle events of the {@link tools} that run. */
  onTool?: OnToolCallback;
  /**
   * Show a submit's input at once, before the server answers, unless this is
   * `false`. Messages without an id get one, so the server's copy replaces
   * them.
   *
   * @default true
   */
  optimistic?: boolean;
}

/** Options of `useStream` against an Agent Server. */
export interface AgentServerOptions<
  StateType extends object,
  ThreadIdType = string | null,
  ApiUrlType = string | undefined,
  ApiKeyType = string | undefined,
>
  extends
    UseStreamCommonOptions<StateType, ThreadIdType>,
    Pick<
      StreamOrchestratorOptions,
      | "maxReconnectAttempts"
      | "reconnectDelayMs"
      | "onReconnect"
      | "onConnected"
      | "streamIdleReconnect"
    > {
  /** The assistant, or graph, that runs on the thread. */
  assistantId: string;
  /**
   * The client for every request. Without it, the hook builds one from
   * `apiUrl`, `apiKey`, `callerOptions` and `defaultHeaders`.
   */
  client?: Client;
  /** The Agent Server's URL. */
  apiUrl?: ApiUrlType;
  /** Sent as the `x-api-key` header. */
  apiKey?: ApiKeyType;
  /**
   * Compared by entry: an object with the same values keeps the client, and
   * a function in it, or a new value, builds a new client and reads the
   * thread again.
   */
  callerOptions?: ClientConfig["callerOptions"];
  /** Compared by entry: headers with the same values keep the client. */
  defaultHeaders?: ClientConfig["defaultHeaders"];
  /** The wire transport: server-sent events. */
  transport?: "sse";
  /**
   * Used for every request of the client the hook builds. Ignored, with a
   * warning, when `client` is passed: set it on that client instead.
   */
  fetch?: typeof fetch;
  /**
   * Where a submit made during a run waits: in the server's queue (the
   * default), so it survives a reload and shows in other tabs, or in this
   * tab with `"local"`. The server's queue creates the run with
   * `POST /threads/{thread_id}/runs`, which a proxy in front of the server
   * must forward too. 1.x stopped the run in flight instead, which
   * `submit()` still does with `multitaskStrategy: "interrupt"`.
   */
  queue?: "local" | "server";
}

/**
 * Options of `useStream` with a custom transport, for a backend of your own
 * that runs the graph and streams what an Agent Server's run streams send.
 */
export interface CustomTransportOptions<
  StateType extends object,
  ThreadIdType = string | null,
> extends UseStreamCommonOptions<StateType, ThreadIdType> {
  /**
   * Sends each run to your backend and returns its event stream, such as a
   * `FetchStreamTransport`. The one passed at the latest render sends each
   * run, so an inline object works.
   */
  transport: UseStreamTransport<StateType & Record<string, unknown>>;
  /** A submit made during a run waits in this page: there is no server queue. */
  queue?: "local";
  assistantId?: never;
  client?: never;
  apiUrl?: never;
  apiKey?: never;
  callerOptions?: never;
  defaultHeaders?: never;
  fetch?: never;
  maxReconnectAttempts?: never;
  reconnectDelayMs?: never;
  onReconnect?: never;
  onConnected?: never;
  streamIdleReconnect?: never;
}

export type UseStreamOptions<
  StateType extends object = Record<string, unknown>,
  ThreadIdType = string | null,
  ApiUrlType = string | undefined,
  ApiKeyType = string | undefined,
> =
  | AgentServerOptions<StateType, ThreadIdType, ApiUrlType, ApiKeyType>
  | CustomTransportOptions<StateType, ThreadIdType>;

type RunConfig<ConfigurableType extends object> = {
  configurable?: ConfigurableType;
  recursion_limit?: number;
  tags?: string[];
  [key: string]: unknown;
};

/** Options of `submit()`. */
export interface StreamSubmitOptions<
  StateType extends object = Record<string, unknown>,
  ConfigurableType extends object = Record<string, unknown>,
> {
  config?: RunConfig<ConfigurableType>;
  metadata?: Record<string, unknown>;
  /** Run from this checkpoint instead of the thread's latest, to edit or retry. */
  forkFrom?: string;
  /**
   * What to do with a run already in flight on the thread. With none, the
   * new run waits in the queue behind it, where 1.x used `"interrupt"`.
   *
   * - `"enqueue"`: wait in the queue.
   * - `"interrupt"`: stop the run in flight, keeping the steps it finished.
   * - `"rollback"`: stop it and delete it, as if it never ran.
   * - `"reject"`: throw.
   */
  multitaskStrategy?: "rollback" | "interrupt" | "enqueue" | "reject";
  /** @deprecated Has no effect. A run is stopped with `stop()`. */
  signal?: AbortSignal;
  /**
   * Submit to this thread instead, loading it first. Later submits stay on
   * it unless the hook's `threadId` changes. An id the server doesn't know
   * yet is created.
   */
  threadId?: string | null;
  /** Called when this run fails. */
  onError?: (error: unknown) => void;
  /** Resume, update or route the graph instead of sending input. */
  command?: Command;
  interruptBefore?: "*" | string[];
  interruptAfter?: "*" | string[];
  /** @internal Type-only: carries the state type. */
  _stateType?: StateType;
}

/** Options of `stop()`. */
export interface StreamStopOptions {
  /**
   * Cancel the run on the server, unless this is `false`, which only stops
   * streaming it here.
   *
   * @default true
   */
  cancel?: boolean;
}

/** Options of `respondAll()`. */
export interface StreamRespondAllOptions<
  ConfigurableType extends object = Record<string, unknown>,
> {
  config?: RunConfig<ConfigurableType>;
  metadata?: Record<string, unknown>;
  /**
   * A state update applied in the same step as the answer, as LangGraph's
   * `Command(update=...)`. Messages may be dicts or `BaseMessage` instances.
   */
  update?: Command["update"];
  /** The node to go to next, as LangGraph's `Command(goto=...)`. */
  goto?: Command["goto"];
  /**
   * Fail the run, instead of running the step again, when an interrupt the
   * answer names is no longer waiting (answered elsewhere, or a wrong id).
   *
   * @default true
   */
  strictResume?: boolean;
}

/** Options of `respond()`. */
export interface StreamRespondOptions<
  ConfigurableType extends object = Record<string, unknown>,
> extends StreamRespondAllOptions<ConfigurableType> {
  /** The interrupt to answer. Defaults to the one `interrupt` shows. */
  interruptId?: string;
  /** @deprecated Has no effect. The interrupt's id identifies it. */
  namespace?: string[];
}

/** A subagent a run started with the `task` tool. */
export interface SubagentDiscoverySnapshot {
  /** Id of the `task` tool call that started it. */
  readonly id: string;
  /** Subagent type, such as `"researcher"`. */
  readonly name: string;
  /**
   * Namespace of its events. `["tools:<id>"]` until it's known, which the
   * selector hooks resolve.
   */
  readonly namespace: readonly string[];
  /** Id of the subagent that started it, or `null` when the main agent did. */
  readonly parentId: string | null;
  /** Nesting depth: 0 when the main agent started it. */
  readonly depth: number;
  readonly status: "running" | "complete" | "error";
  /** The task description it was given. */
  readonly taskInput: string | undefined;
  /** Its result, once complete. */
  readonly output: unknown;
  readonly error: string | undefined;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}

/** A submit waiting in the queue. */
export interface SubmissionQueueEntry<
  StateType extends object = Record<string, unknown>,
> {
  readonly id: string;
  /** The run's id, when it waits in the server's queue. */
  readonly runId?: string;
  readonly values: Partial<StateType> | null | undefined;
  /** The submit's options, without `forkFrom` and `threadId`, which only start it. */
  readonly options?: Omit<
    StreamSubmitOptions<StateType>,
    "forkFrom" | "threadId"
  >;
  readonly createdAt: Date;
}

export type SubmissionQueueSnapshot<
  StateType extends object = Record<string, unknown>,
> = ReadonlyArray<SubmissionQueueEntry<StateType>>;

/** What `useMessageMetadata` returns for a message. */
export type MessageMetadata =
  MessageMetadataMap extends ReadonlyMap<string, infer Metadata>
    ? Metadata
    : never;

export type { MessageMetadataMap };

type EventOf<Method extends string, Data> = {
  method: Method;
  params: {
    /** Where the event happened: `[]` for the main graph. */
    namespace: string[];
    /** When this client received it. */
    timestamp: number;
    data: Data;
  };
};

/** A stream event as `useChannel` and `useChannelEffect` give it. */
export type Event =
  | EventOf<"values" | "updates", Record<string, unknown>>
  | EventOf<"messages", [message: Message, metadata: Record<string, unknown>]>
  | EventOf<"custom", { payload: unknown }>
  | EventOf<
      "tools",
      | {
          event: "tool-started";
          tool_call_id: string;
          tool_name: string;
          input: unknown;
        }
      | { event: "tool-progress"; tool_call_id: string; data: unknown }
      | { event: "tool-finished"; tool_call_id: string; output: unknown }
      | { event: "tool-error"; tool_call_id: string; message: string }
    >
  | EventOf<
      "lifecycle",
      {
        event: "started" | "completed" | "failed" | "interrupted";
        cause?: { type: "toolCall"; tool_call_id: string };
        error?: string;
      }
    >;

export type Channel = Event["method"];
