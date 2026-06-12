import type {
  AgentResult,
  Channel,
  Event,
  InputInjectParams,
  InputRespondParams,
  ListCheckpointsParams,
  ListCheckpointsResult,
  RunStartParams,
  RunResult,
  StateForkParams,
  StateForkResult,
  StateGetParams,
  StateGetResult,
  SubscribeParams,
} from "@langchain/protocol";

import type { IdleReconnectMode } from "../../utils/stream.js";
import type { AssembledMessage } from "./messages.js";
import type { AgentServerAdapter } from "./transport.js";

export interface ExtendedRunStartParams extends RunStartParams {
  forkFrom?: string;
  multitaskStrategy?: "reject" | "rollback" | "interrupt" | "enqueue";
}

export type SubscribeOptions = Omit<SubscribeParams, "channels">;

export type EventMethodByChannel = {
  values: "values";
  updates: "updates";
  messages: "messages";
  tools: "tools";
  custom: "custom";
  lifecycle: "lifecycle";
  input: "input.requested";
  debug: "debug";
  checkpoints: "checkpoints";
  tasks: "tasks";
};

export type EventForChannel<TChannel extends Channel> =
  TChannel extends keyof EventMethodByChannel
    ? Extract<Event, { method: EventMethodByChannel[TChannel] }>
    : TChannel extends `custom:${string}`
      ? Extract<Event, { method: "custom" }>
      : never;

export type EventForChannels<TChannels extends readonly Channel[]> =
  EventForChannel<TChannels[number]>;

/**
 * Maps a subscribable channel to the type yielded by its subscription handle.
 *
 * - `"custom:name"` channels yield `unknown` (the raw emitted payload).
 * - All other channels yield the full protocol `Event`.
 */
export type YieldForChannel<TChannel extends Channel> =
  TChannel extends `custom:${string}` ? unknown : EventForChannel<TChannel>;

export type YieldForChannels<TChannels extends readonly Channel[]> =
  YieldForChannel<TChannels[number]>;

/**
 * Built-in wire transport used by {@link ThreadStream}.
 *
 * - `"sse"`: HTTP commands + one SSE event stream per subscription.
 *   Works in browsers without extra setup.
 * - `"websocket"`: single bidirectional WebSocket. Lower overhead for
 *   long-lived, multi-subscription sessions.
 */
export type ThreadStreamTransportKind = "sse" | "websocket";

/**
 * Accepted values for `ThreadStreamOptions["transport"]`.
 *
 * - A {@link ThreadStreamTransportKind} string picks one of the
 *   built-in factories; `fetch` / `webSocketFactory` tune that path.
 * - An {@link AgentServerAdapter} bypasses the built-in factories
 *   entirely; the adapter is used for every command and subscription.
 */
export type ThreadStreamTransport =
  | ThreadStreamTransportKind
  | AgentServerAdapter;

/**
 * Options for {@link ThreadStream} construction.
 */
export interface ThreadStreamOptions {
  /**
   * Assistant that this thread runs on. A thread is bound to one
   * assistant for its lifetime — subsequent `run.start` calls always
   * use this assistant.
   */
  assistantId: string;
  /**
   * How this thread talks to the agent server. Accepts either a
   * built-in transport string or a custom {@link AgentServerAdapter}:
   *
   * - `"sse"`: HTTP commands + one SSE event stream per subscription.
   * - `"websocket"`: single bidirectional WebSocket.
   * - an {@link AgentServerAdapter}: custom transport that replaces
   *   the built-in factories entirely. `fetch` / `webSocketFactory`
   *   are ignored in this mode.
   *
   * Defaults to the client-level `streamProtocol`
   * (`"v2-websocket"` → `"websocket"`, otherwise `"sse"`).
   */
  transport?: ThreadStreamTransport;
  /**
   * Starting command ID for the internal command counter. Mostly
   * useful for tests.
   */
  startingCommandId?: number;
  /**
   * Optional `fetch` implementation for the built-in SSE transport.
   * Useful for test environments, custom auth/proxy layers, or
   * non-global fetch (e.g. Node without a global fetch, or injected
   * mocks). Ignored for the WebSocket transport and for custom
   * {@link AgentServerAdapter}s.
   */
  fetch?: typeof fetch;
  /**
   * Optional WebSocket factory for the built-in WebSocket transport.
   * Useful for test environments that don't ship a global `WebSocket`,
   * or to wrap the socket with custom headers/subprotocols. Ignored
   * for the SSE transport and for custom {@link AgentServerAdapter}s.
   */
  webSocketFactory?: (url: string) => WebSocket;
  /**
   * Built-in `"sse"` / `"websocket"` transports only: max reconnect
   * attempts after an unexpected disconnect. Defaults to 5.
   */
  maxReconnectAttempts?: number;
  /**
   * Built-in `"sse"` transport only: idle-reconnect policy guarding against
   * half-open sockets that hang with no error or close (e.g. a platform
   * revision rollover).
   *
   * - `"auto"` (default): arm only once the server's SSE keep-alive
   *   heartbeats are observed (LangGraph Platform emits `: heartbeat` every
   *   ~5s), sizing the window from their cadence. Independent of agent
   *   activity; stays dormant on heartbeat-less servers.
   * - a `number`: a fixed idle window in milliseconds.
   * - `0`: disables it.
   */
  streamIdleReconnect?: IdleReconnectMode;
  /**
   * Built-in transports only: delay before each reconnect attempt.
   * Defaults to exponential backoff with jitter.
   */
  reconnectDelayMs?: (attempt: number) => number;
  /**
   * Built-in transports only: invoked before each reconnect attempt.
   */
  onReconnect?: (options: { attempt: number; cause: unknown }) => void;
}

export interface SessionOrderingState {
  lastSeenSeq?: number;
  lastAppliedThroughSeq?: number;
  lastEventId?: string;
}

export interface EventSubscription<
  TYield = Event,
> extends AsyncIterable<TYield> {
  readonly subscriptionId: string;
  readonly params: SubscribeParams;
  unsubscribe(): Promise<void>;
}

export interface MessageSubscription extends AsyncIterable<AssembledMessage> {
  readonly subscriptionId: string;
  readonly params: SubscribeParams;
  unsubscribe(): Promise<void>;
}

export interface InputModule {
  respond(params: InputRespondParams): Promise<void>;
  inject(params: InputInjectParams): Promise<void>;
}

export interface StateModule {
  get(params: StateGetParams): Promise<StateGetResult>;
  listCheckpoints(
    params: ListCheckpointsParams
  ): Promise<ListCheckpointsResult>;
  fork(params: StateForkParams): Promise<StateForkResult>;
}

/**
 * Modules exposed by the high-level {@link ThreadStream} wrapper.
 */
export interface ThreadModules {
  run: {
    /**
     * Start a new run, resume an interrupted run, or inject input into
     * an active run on this thread. The assistant is fixed by the
     * {@link ThreadStream} constructor and cannot be changed per-call.
     */
    start(
      params: Omit<ExtendedRunStartParams, "assistant_id">
    ): Promise<RunResult>;
  };
  agent: {
    getTree(params?: { run_id?: string }): Promise<AgentResult>;
  };
  input: InputModule;
  state: StateModule;
}

/**
 * Human-in-the-loop interrupt payload surfaced from lifecycle events.
 * Matches the in-process `InterruptPayload` type.
 *
 * {@link ThreadStream.interrupts} collects these entries in arrival order.
 * Use them (via {@link StreamController.getThread `getThread()`}) when
 * you need the protocol `namespace` tuple for
 * {@link StreamController.respond `respond()`} — for example subgraph
 * interrupts that are not mirrored on {@link RootSnapshot.interrupts}.
 */
export interface InterruptPayload<TPayload = unknown> {
  interruptId: string;
  payload: TPayload;
  /** Protocol namespace tuple the server validates on resume (`[]` at root). */
  namespace: string[];
}

/**
 * Remote counterpart of an in-process `run.extensions.<name>` projection.
 *
 * Each extension is the client-side view of a compile-time
 * {@link StreamTransformer} projection. The server auto-forwards named
 * `StreamChannel.remote(name)` outputs on the `custom:<name>` channel, and
 * this handle exposes them via two dual interfaces:
 *
 *  - `AsyncIterable<T>` — iterate every item pushed by a streaming
 *    transformer (e.g. a `StreamChannel`).
 *  - `PromiseLike<T>` — `await` resolves with the final value observed
 *    when the run terminates. For streaming transformers this is the
 *    last item pushed; for final-value transformers it is the single
 *    value emitted on run end.
 *
 * Subscribing is lazy: the underlying `custom:<name>` subscription is
 * opened on first property access and cached.
 */
export interface ThreadExtension<T = unknown>
  extends AsyncIterable<T>, PromiseLike<T> {}

/**
 * Unwrap a single in-process projection value to its observable payload
 * type:
 *
 *   - `Promise<T>` / `PromiseLike<T>` → `T` (final-value transformers)
 *   - `StreamChannel<T>` / `AsyncIterable<T>` → `T` (streaming transformers)
 *   - anything else → the value itself
 *
 * This lets a `ThreadStream<TExtensions>` generic accept the same shape
 * that `graph.streamEvents(..., { version: "v3" })` returns in-process
 * (via `InferExtensions<TTransformers>` from `@langchain/langgraph`),
 * without forcing users to redeclare payload types on the remote side.
 */
export type UnwrapExtension<T> =
  T extends PromiseLike<infer U> ? U : T extends AsyncIterable<infer U> ? U : T;

/**
 * Keyed map of {@link ThreadExtension} handles, typed off a declared
 * transformer projection shape.
 *
 * Used as the return type of `ThreadStream.extensions`. `TExtensions`
 * is expected to match the in-process `run.extensions` shape (i.e. the
 * output of `InferExtensions<TTransformers>` from
 * `@langchain/langgraph`); each value type is unwrapped via
 * {@link UnwrapExtension} so `thread.extensions.foo` resolves with the
 * transformer's emitted payload, not the in-process `Promise<T>` /
 * `StreamChannel<T>` wrapper.
 *
 * Access any string key to obtain a `ThreadExtension<unknown>`; keys
 * that appear in `TExtensions` narrow to their declared payload type.
 */
export type ThreadExtensions<
  TExtensions extends Record<string, unknown> = Record<string, unknown>,
> = {
  readonly [K in keyof TExtensions]: ThreadExtension<
    UnwrapExtension<TExtensions[K]>
  >;
} & {
  readonly [name: string]: ThreadExtension<unknown>;
};
