/**
 * Framework-agnostic types for the experimental v2 stream runtime.
 *
 * This module (and its siblings under `stream/`) is the
 * pure-TypeScript core that framework bindings (React / Vue / Svelte /
 * Angular) compose over. It deliberately has zero framework imports so
 * each binding can choose its own reactivity primitive.
 */
import type { BaseMessage } from "@langchain/core/messages";
import type { Interrupt } from "../schema.js";
import type { Client, ClientConfig } from "../client/index.js";
import type {
  ThreadStream,
  ThreadStreamOptions,
} from "../client/stream/index.js";
import type { AssembledToolCall } from "../client/stream/handles/tools.js";
import type {
  AgentServerAdapter,
  TransportAdapter,
} from "../client/stream/transport.js";
import type {
  AnyHeadlessToolImplementation,
  OnToolCallback,
} from "../headless-tools.js";
import type { InferStateType } from "./types-inference.js";
import type { Channel, Event } from "@langchain/protocol";
import type { StreamStore } from "./store.js";

/**
 * Legacy alias shared by the framework bindings.
 * Unwraps a compiled graph or agent brand into its state shape.
 *
 * @deprecated Prefer {@link InferStateType}.
 */
export type StateOf<T> =
  InferStateType<T> extends Record<string, unknown>
    ? InferStateType<T>
    : Record<string, unknown>;

/** Options common to both transport branches of framework `useStream` APIs. */
export interface UseStreamCommonOptions<
  StateType extends object,
  ThreadIdType = string | null,
> {
  threadId?: ThreadIdType;
  onThreadId?: (threadId: string) => void;
  onCreated?: (meta: { run_id: string; thread_id: string }) => void;
  initialValues?: StateType;
  /** State key holding the message array. Defaults to `"messages"`. */
  messagesKey?: string;
  /** Headless tool implementations; auto-resumes matching interrupts. */
  tools?: AnyHeadlessToolImplementation[];
  /** Observe lifecycle events for registered {@link tools}. */
  onTool?: OnToolCallback;
}

/**
 * Agent-server branch: caller points `useStream` at an assistant on a
 * LangGraph-Platform-compatible server. Discriminated against
 * {@link CustomAdapterOptions} by `transport` being absent or a string.
 */
export interface AgentServerOptions<
  StateType extends object,
  ThreadIdType = string | null,
  ApiUrlType = string | undefined,
  ApiKeyType = string | undefined,
> extends UseStreamCommonOptions<StateType, ThreadIdType> {
  assistantId: string;
  client?: Client;
  apiUrl?: ApiUrlType;
  apiKey?: ApiKeyType;
  callerOptions?: ClientConfig["callerOptions"];
  defaultHeaders?: ClientConfig["defaultHeaders"];
  /** Built-in wire transport. Defaults to `"sse"`. */
  transport?: "sse" | "websocket";
  /** Optional `fetch` override forwarded to the built-in SSE transport. */
  fetch?: typeof fetch;
  /** Optional `WebSocket` factory for the built-in WS transport. */
  webSocketFactory?: (url: string) => WebSocket;
}

/**
 * Custom-adapter branch: caller brings their own
 * {@link AgentServerAdapter}. Discriminated against
 * {@link AgentServerOptions} by `transport` being an adapter instance.
 */
export interface CustomAdapterOptions<
  StateType extends object,
  ThreadIdType = string | null,
  CustomAssistantIdType = never,
> extends UseStreamCommonOptions<StateType, ThreadIdType> {
  /**
   * Custom {@link AgentServerAdapter} used for every command and
   * subscription. Replaces the built-in `sse`/`websocket` factories
   * entirely.
   */
  transport: AgentServerAdapter;
  /**
   * Optional assistant id passed through to the adapter. Defaults to
   * `"_"`; adapters that don't multiplex on assistant id can ignore it.
   */
  assistantId?: CustomAssistantIdType;
  client?: never;
  apiUrl?: never;
  apiKey?: never;
  callerOptions?: never;
  defaultHeaders?: never;
  fetch?: never;
  webSocketFactory?: never;
}

/**
 * Options accepted by framework `useStream` APIs. Discriminated on the
 * shape of `transport`:
 *
 * - omitted or a string (`"sse"` / `"websocket"`) -> agent-server branch
 *   ({@link AgentServerOptions}); supply `assistantId` + `apiUrl`.
 * - an {@link AgentServerAdapter} instance -> custom-adapter branch
 *   ({@link CustomAdapterOptions}); bring your own transport.
 */
export type UseStreamOptions<
  StateType extends object = Record<string, unknown>,
  ThreadIdType = string | null,
  ApiUrlType = string | undefined,
  ApiKeyType = string | undefined,
  CustomAssistantIdType = never,
> =
  | AgentServerOptions<StateType, ThreadIdType, ApiUrlType, ApiKeyType>
  | CustomAdapterOptions<StateType, ThreadIdType, CustomAssistantIdType>;

/**
 * Read-only fan-out of the {@link StreamController}'s always-on root
 * subscription. Projections that only need a subset of the root pump's
 * channels at the root namespace can attach here instead of opening a
 * second server subscription.
 */
export interface RootEventBus {
  /** Channels covered by the root pump. */
  readonly channels: readonly Channel[];
  /** Subscribe; returns an unsubscribe handle. */
  subscribe(listener: (event: Event) => void): () => void;
}

/**
 * Always-on root snapshot surfaced by {@link StreamController.rootStore}.
 *
 * Populated by a single multi-channel subscription at the thread root
 * (`values`, `lifecycle`, `input`, `messages`, `tools`). Every app
 * pays for this — selector hooks for scoped projections layer on top.
 */
export interface RootSnapshot<
  StateType extends object = Record<string, unknown>,
  InterruptType = unknown,
> {
  /** Latest state values from the `values` channel. */
  values: StateType;
  /** Root-namespace messages (class instances). */
  messages: BaseMessage[];
  /** Root-namespace tool calls (assembled). */
  toolCalls: AssembledToolCall[];
  /** Interrupts observed on the root namespace. */
  interrupts: Interrupt<InterruptType>[];
  /** Convenience alias for `interrupts[0]`. */
  interrupt: Interrupt<InterruptType> | undefined;
  /** True while a run is active / being started on the current thread. */
  isLoading: boolean;
  /** True while the initial `thread.state.get()` hydration is in flight. */
  isThreadLoading: boolean;
  /** Last error observed on the active run / hydration. */
  error: unknown;
  /** Current thread id (may be `null` until the first `submit`). */
  threadId: string | null;
}

export interface StreamControllerOptions<
  StateType extends object = Record<string, unknown>,
> {
  /** Assistant the thread is bound to for its lifetime. */
  assistantId: string;
  /** Client used to construct `ThreadStream`s. */
  client: Client<StateType>;
  /** Initial thread id; if `null`, one is generated on first submit. */
  threadId?: string | null;
  /**
   * How the controller talks to the agent server. Accepts either a
   * built-in transport string (`"sse"` / `"websocket"`) or a custom
   * {@link import("../client/stream/transport.js").AgentServerAdapter}
   * that bypasses the built-in factories entirely. Forwarded to
   * `client.threads.stream({ transport })`.
   */
  transport?: ThreadStreamOptions["transport"];
  /** Optional `fetch` override forwarded to the built-in SSE transport. */
  fetch?: typeof fetch;
  /** Optional `WebSocket` factory forwarded to the built-in WS transport. */
  webSocketFactory?: (url: string) => WebSocket;
  /** Called when a thread id is first produced (new-thread submits). */
  onThreadId?: (threadId: string) => void;
  /** Called when a run starts (mirrors v1 `onCreated`). */
  onCreated?: (meta: { run_id: string; thread_id: string }) => void;
  /** Initial state for `root.values` before hydration lands. */
  initialValues?: StateType;
  /** Key inside `values` that holds the message array. Defaults to `"messages"`. */
  messagesKey?: string;
}

export interface StreamSubmitOptions<
  StateType extends object = Record<string, unknown>,
  ConfigurableType extends object = Record<string, unknown>,
> {
  config?: {
    configurable?: ConfigurableType;
    recursion_limit?: number;
    tags?: string[];
    [key: string]: unknown;
  };
  metadata?: Record<string, unknown>;
  /**
   * Command shape widened to the v1 surface + protocol-v2 additions.
   *
   * - `resume` — dispatches to `thread.input.respond` targeting the most
   *   recent root-namespace interrupt (honoured today).
   * - `goto` — routes execution to a specific node (planned, forwarded
   *   via `/run.start` metadata).
   * - `update` — merges a partial state update into the thread's
   *   values before resuming (planned, forwarded via `/run.start`).
   *
   * Only `resume` is currently executed by the controller; `goto` /
   * `update` are accepted by the type surface so callers can migrate
   * without breakage once the server work lands (plan-roadmap.md §5.3
   * R2.4).
   */
  command?: {
    resume?: unknown;
    goto?: string | { node: string; input?: unknown };
    update?: Partial<StateType>;
  };
  /**
   * Fork the run from an explicit checkpoint instead of the thread's
   * latest. Emits a `forkFrom` field on the `/run.start` request that
   * the API layer forwards to
   * `graph.streamEvents(input, { version: "v3", forkFrom })`.
   *
   * See plan-roadmap.md §5.3 R2.4.
   */
  forkFrom?: { checkpointId: string };
  /**
   * Behaviour when a run is already in-flight on the thread.
   *
   * - `"rollback"` (default) — abort the active run client-side and
   *   start the new one immediately.
   * - `"interrupt"` — server-side cancel of the in-flight run, then
   *   start the new one (requires API support, roadmap A0.3).
   * - `"enqueue"` — do NOT abort the active run; the new submission
   *   lands in {@link StreamController.queueStore} and is forwarded
   *   once the current run terminates.
   * - `"reject"` — error out client-side when a run is already in
   *   flight.
   *
   * Only `"rollback"` is honoured client-side today; the other three
   * are accepted on the type surface so callers can start migrating
   * ahead of the matching server work (plan-roadmap.md §5.3 R2.3 and
   * A0.3).
   */
  multitaskStrategy?: "rollback" | "interrupt" | "enqueue" | "reject";
  signal?: AbortSignal;
  /**
   * Per-submit thread-id override. When provided, the controller
   * rebinds to this thread before dispatching the run; subsequent
   * submits stick with the new id unless the hook's `threadId` prop
   * changes. Useful when you want to start a new thread without
   * unmounting the component (e.g. "New Chat" buttons).
   */
  threadId?: string | null;
  /**
   * Per-submit error callback. Invoked when the run errors out —
   * either before the first event lands (network/dispatch failure)
   * or mid-stream. Does NOT suppress the error from being written
   * to {@link RootSnapshot.error}; the callback is a local hook for
   * showing toasts or routing the submission error to a component
   * state slot, letting the rest of the UI keep using
   * `stream.error` for render-level error display.
   */
  onError?: (error: unknown) => void;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _stateType?: StateType;
}

/**
 * Lightweight discovery record for a subagent running inside the thread.
 *
 * Populated eagerly from the root subscription (`tools` + `lifecycle`
 * channels). Content projections (`messages`, `toolCalls`, custom
 * extensions) are opened lazily via selector hooks, keyed on
 * {@link namespace}.
 */
export interface SubagentDiscoverySnapshot {
  /** Tool-call id that created the subagent. */
  readonly id: string;
  /** Subagent type, e.g. `"researcher"`. */
  readonly name: string;
  /** Namespace prefix for every event emitted by this subagent. */
  readonly namespace: readonly string[];
  /** Parent subagent id, or `null` if spawned from the root. */
  readonly parentId: string | null;
  /** Nesting depth from the root (root = 0). */
  readonly depth: number;
  /** Lifecycle status derived from task tool events. */
  readonly status: "running" | "complete" | "error";
  /** Task description passed to the subagent. */
  readonly taskInput: string | undefined;
  /** Raw output payload once the subagent completes. */
  readonly output: unknown;
  /** Error message if the subagent failed. */
  readonly error: string | undefined;
  /** Wall-clock timestamp when the task tool started. */
  readonly startedAt: Date;
  /** Wall-clock timestamp when the task tool terminated (null if running). */
  readonly completedAt: Date | null;
}

/**
 * Lightweight discovery record for a subgraph running inside the thread.
 */
export interface SubgraphDiscoverySnapshot {
  readonly id: string;
  readonly namespace: readonly string[];
  /**
   * Name of the graph node that produced this subgraph invocation,
   * parsed from the last namespace segment. LangGraph assigns every
   * node invocation a checkpoint namespace shaped like
   * `<node_name>:<uuid>`; this is the `<node_name>` half, letting
   * callers key lookups on names they recognise from
   * `addNode(name, …)` without parsing the namespace themselves.
   */
  readonly nodeName: string;
  readonly status: "running" | "complete" | "error";
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}

/**
 * Anything with a `namespace` can be passed to selector hooks as a
 * scope target. Both {@link SubagentDiscoverySnapshot} and
 * {@link SubgraphDiscoverySnapshot} satisfy this; callers can also
 * hand-build `{ namespace: [...] }` objects.
 */
export type Target = undefined | { readonly namespace: readonly string[] };

/**
 * A projection spec describes a single logical subscription managed
 * by the {@link ChannelRegistry}. Framework bindings don't construct
 * these directly — the per-kind factory functions in
 * `stream/projections/` emit them.
 */
export interface ProjectionSpec<T> {
  /**
   * Identity key. Two specs with the same key share one registry
   * entry (and thus one server subscription + one store) across all
   * consumers.
   */
  readonly key: string;
  /** Namespace this projection is scoped to (`[]` = root). */
  readonly namespace: readonly string[];
  /** Initial store value before any events arrive. */
  readonly initial: T;
  /**
   * Open the projection against a bound {@link ThreadStream} and
   * start pumping events into `store`. Called once per registry entry
   * (not per consumer). The returned `dispose` function is invoked
   * when the registry's ref count for this entry drops to zero or
   * when the registry is rebound to a different thread.
   */
  open(params: {
    thread: ThreadStream;
    store: StreamStore<T>;
    /**
     * Read-only fan-out of the controller's always-on root
     * subscription. Projections scoped to the root namespace whose
     * channel set is a subset of {@link RootEventBus.channels} should
     * subscribe here instead of opening a second server subscription.
     */
    rootBus: RootEventBus;
  }): ProjectionRuntime;
}

export interface ProjectionRuntime {
  dispose(): Promise<void> | void;
}

/**
 * Handle returned by `ChannelRegistry.acquire`. Framework bindings
 * use `store` as the reactivity source and must call `release()` when
 * the consumer tears down.
 */
export interface AcquiredProjection<T> {
  readonly store: StreamStore<T>;
  release(): void;
}

export type {
  AgentServerAdapter,
  TransportAdapter,
  BaseMessage,
  ThreadStream,
  Event,
};
