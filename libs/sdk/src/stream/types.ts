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
import type { Channel, Event, Goto } from "@langchain/protocol";
import type { StreamStore } from "./store.js";

/** Why a run's active streaming phase ended. */
export type RunExecutionReason =
  /** The run reached the protocol `completed` lifecycle event. */
  | "success"
  /** The run reached the protocol `failed` lifecycle event. */
  | "error"
  /** The run paused on a protocol `interrupted` lifecycle event. */
  | "interrupt"
  /** The run was stopped by a client-side abort. */
  | "stopped";

/** Payload for run-start callbacks. */
export interface RunExecutionInfo {
  runId: string;
}

/** Options for {@link StreamController.stop} / framework `stop()`. */
export interface StreamStopOptions {
  /**
   * When `true` (default), issue a server-side cancel via
   * `client.runs.cancel` for the active run before disconnecting the
   * client transport. Set to `false` for join/rejoin flows where the
   * agent should keep running after the client disconnects.
   */
  cancel?: boolean;
}

/**
 * Options for {@link StreamController.respondAll} / framework
 * `respondAll()`.
 *
 * Carries run-level `config` / `metadata` onto the single run that
 * services the batched resume — the same fields as
 * {@link StreamRespondOptions}, minus the per-interrupt target (each
 * response in the map carries its own `interruptId` as the key).
 */
export interface StreamRespondAllOptions<
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
   * State update applied in the **same superstep** as the resume, mapped to
   * LangGraph's `Command(update=...)`. The resumed run produces a single
   * checkpoint reflecting both the resume value and this update — no separate
   * `updateState` write, no intermediate checkpoint, no flicker.
   *
   * The canonical use case is a HITL flow where the UI pushes the interrupt
   * card (e.g. an `AIMessage`) into state at the moment it answers the
   * interrupt, so the card is committed before the resumed tool runs and stays
   * rendered without the backend re-emitting it.
   *
   * Accepts a state-keys object (shallow-merged via the graph's channel
   * reducers) or a list of `[key, value]` entries.
   *
   * Messages under the configured `messagesKey` may be either plain
   * message dicts (`{ type: "ai", content: "…" }`) or `@langchain/core`
   * `BaseMessage` instances (`new AIMessage("…")`) — instances are
   * serialized to dicts before transport, exactly like `submit()`.
   */
  update?: Record<string, unknown> | [string, unknown][];
  /**
   * Directed jump applied in the **same superstep** as the resume, mapped to
   * LangGraph's `Command(goto=...)`. A target node name, a `Send`
   * (`{ node, input }`), or a list mixing the two for fan-out.
   */
  goto?: Goto;
}

/**
 * Options for {@link StreamController.respond} / framework `respond()`.
 *
 * Targets a single pending interrupt (`interruptId` / `namespace`) and
 * carries run-level `config` and `metadata` onto the resume so the
 * resumed run applies the same configurable values (model, user context,
 * timezone, …) and metadata (trigger source, test flags, …) a fresh
 * {@link StreamSubmitOptions} would. The server folds these into the run
 * it starts to service the `input.respond` command.
 *
 * To resume several interrupts pending at the same checkpoint, use
 * {@link StreamController.respondAll} instead.
 */
export interface StreamRespondOptions<
  ConfigurableType extends object = Record<string, unknown>,
> extends StreamRespondAllOptions<ConfigurableType> {
  /**
   * Target a specific pending interrupt. Omit when exactly one
   * interrupt is pending to resume the newest unresolved one; pass it
   * when several can be active (parallel subagents, fan-out, nested
   * graphs) so you resume the interrupt the user acted on.
   */
  interruptId?: string;
  /**
   * Namespace of the targeted interrupt. Root interrupts use `[]` (the
   * default when omitted). Subgraph interrupts require the exact tuple
   * from `getThread()?.interrupts`.
   */
  namespace?: string[];
}

/** Payload for run-end callbacks. */
export interface RunCompletedInfo extends Omit<RunExecutionInfo, "runId"> {
  /** Omitted when re-attaching to an in-flight run without local dispatch. */
  runId?: string;
  /** Why the active streaming phase ended. */
  reason: RunExecutionReason;
}

/** Options common to both transport branches of framework `useStream` APIs. */
export interface UseStreamCommonOptions<
  StateType extends object,
  ThreadIdType = string | null,
> {
  threadId?: ThreadIdType;
  onThreadId?: (threadId: string) => void;
  /**
   * Convenience callback fired when this hook instance's run is accepted
   * by the server. Prefer `stream.isLoading` for UI; use this for
   * imperative run-execution side effects.
   */
  onCreated?: (info: RunExecutionInfo) => void;
  /**
   * Convenience callback fired when a run's active streaming phase ends.
   * `runId` may be omitted for re-attached in-flight runs because no local
   * dispatch response was observed.
   */
  onCompleted?: (info: RunCompletedInfo) => void;
  initialValues?: StateType;
  /** State key holding the message array. Defaults to `"messages"`. */
  messagesKey?: string;
  /** Headless tool implementations; auto-resumes matching interrupts. */
  tools?: AnyHeadlessToolImplementation[];
  /** Observe lifecycle events for registered {@link tools}. */
  onTool?: OnToolCallback;
  /**
   * Optimistic UI for `submit()`. When enabled (the default), the input
   * passed to `submit()` is reflected in `values` / `messages`
   * immediately — before the server responds — then reconciled against
   * the authoritative server state as it streams in:
   *
   *   - Messages in the input are appended right away. Any message
   *     without an `id` is assigned a stable client id (sent to the
   *     server, which `add_messages` preserves) so the server echo
   *     reconciles by id instead of duplicating. Per-message progress
   *     is exposed via `useMessageMetadata(stream, id).optimisticStatus`
   *     (`"pending"` → `"sent"`, or `"failed"` if the run errors before
   *     the message is echoed; failed optimistic messages are kept for
   *     retry UIs and dropped on the next `hydrate()`).
   *   - Other input keys are shallow-merged into `values` and converge
   *     to server truth on the first `values` event (or are rolled back
   *     if the run fails before any echo).
   *
   * Set to `false` to dispatch input verbatim with no client-side echo
   * or id minting (server-authoritative only) — useful for non-chat
   * state graphs or deterministic SSR/tests.
   *
   * @default true
   */
  optimistic?: boolean;
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
  /**
   * Optional fast path for idle/stale threads: seed a scoped projection from
   * checkpoint history instead of opening a replaying `/events` subscription.
   * This produces a snapshot for finished-thread reconnects; active and
   * interrupted threads return `false` so projections subscribe normally.
   * Returns `false` when history cannot satisfy the projection and the caller
   * should fall back to its normal subscription.
   */
  trySeedFromHistory?<T>(params: {
    kind: "messages" | "toolCalls";
    namespace: readonly string[];
    store: StreamStore<T>;
  }): Promise<boolean>;
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
   * {@link AgentServerAdapter} that bypasses the built-in factories
   * entirely. Forwarded to `client.threads.stream({ transport })`.
   */
  transport?: ThreadStreamOptions["transport"];
  /** Optional `fetch` override forwarded to the built-in SSE transport. */
  fetch?: typeof fetch;
  /** Optional `WebSocket` factory forwarded to the built-in WS transport. */
  webSocketFactory?: (url: string) => WebSocket;
  /** Called when a thread id is first produced (new-thread submits). */
  onThreadId?: (threadId: string) => void;
  /**
   * Convenience callback fired when this hook instance's run is accepted
   * by the server. Prefer `root.isLoading` for UI; use this for
   * imperative run-execution side effects.
   */
  onCreated?: (info: RunExecutionInfo) => void;
  /**
   * Convenience callback fired when a run's active streaming phase ends.
   * `runId` may be omitted for re-attached in-flight runs because no local
   * dispatch response was observed.
   */
  onCompleted?: (info: RunCompletedInfo) => void;
  /** Initial state for `root.values` before hydration lands. */
  initialValues?: StateType;
  /** Key inside `values` that holds the message array. Defaults to `"messages"`. */
  messagesKey?: string;
  /**
   * Optimistic UI for `submit()`. Defaults to `true`. See
   * {@link UseStreamCommonOptions.optimistic} for the full contract.
   */
  optimistic?: boolean;
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
   * Fork the run from an explicit checkpoint instead of the thread's
   * latest. Ergonomic alias the SDK folds into
   * `config.configurable.checkpoint_id` before dispatching the run, so
   * the server receives the fork target via the single legacy-compliant
   * field (never a top-level `forkFrom`).
   */
  forkFrom?: string;
  /**
   * Behaviour when a run is already in-flight on the thread.
   *
   * - `"rollback"` (default) — abort the active run client-side and
   *   start the new one immediately.
   * - `"interrupt"` — server-side cancel of the in-flight run, then
   *   start the new one.
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
