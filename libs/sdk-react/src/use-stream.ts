/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { BaseMessage } from "@langchain/core/messages";
import type { Client, Interrupt } from "@langchain/langgraph-sdk";
import {
  applyHeadlessToolResumeCommand,
  filterOutHeadlessToolInterrupts,
  flushPendingHeadlessToolInterrupts,
} from "@langchain/langgraph-sdk";
import {
  Client as ClientCtor,
  type ClientConfig,
  resolveClientApiUrl,
  type ThreadStream,
} from "@langchain/langgraph-sdk/client";
import {
  StreamController,
  type AgentServerAdapter,
  type AgentServerOptions as StreamAgentServerOptions,
  type AssembledToolCall,
  type ChannelRegistry,
  type CustomAdapterOptions as StreamCustomAdapterOptions,
  type InferStateType,
  type InferSubagentStates,
  type InferToolCalls,
  type RootSnapshot,
  type RunCompletedInfo,
  type RunExecutionInfo,
  type StreamRespondAllOptions,
  type StreamRespondOptions,
  type StreamStopOptions,
  type StreamSubmitOptions,
  type SubagentDiscoverySnapshot,
  type SubagentMap,
  type SubgraphByNodeMap,
  type SubgraphDiscoverySnapshot,
  type SubgraphMap,
  type UseStreamOptions as StreamUseStreamOptions,
  type WidenUpdateMessages,
} from "@langchain/langgraph-sdk/stream";

export type AgentServerOptions<StateType extends object> =
  StreamAgentServerOptions<StateType>;

export type CustomAdapterOptions<StateType extends object> =
  StreamCustomAdapterOptions<StateType>;

export type UseStreamOptions<
  StateType extends object = Record<string, unknown>,
> = StreamUseStreamOptions<StateType>;

/**
 * Private field on the hook return that carries the
 * {@link StreamController} reference. Selector hooks (`useMessages`,
 * `useToolCalls`, …) read this to reach the shared
 * {@link ChannelRegistry}. Typed as a symbol-keyed field to discourage
 * end-user access — use the selector hooks instead.
 *
 * Exported as a unique symbol so type narrowing works across
 * `useMessages(stream, target)` call sites.
 */
export const STREAM_CONTROLLER: unique symbol = Symbol.for(
  "@langchain/react/controller"
);

export interface UseStreamReturn<
  T = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
  StateType extends object = InferStateType<T>,
  SubagentStates = InferSubagentStates<T>,
> {
  // ----- always-on root projections -----
  /**
   * The most recent `values`-channel snapshot emitted at the root
   * namespace — i.e. the thread-level state as the server sees it
   * after each superstep. Updated on every root `values` event, not
   * on token-level deltas: if you render `values.messages` directly
   * you'll see full turns appear at once instead of streaming
   * token-by-token. Use {@link messages} (or `useMessages`) for the
   * token-streamed view.
   *
   * Equivalent to calling `useValues(stream)`.
   */
  readonly values: StateType;
  /**
   * Type-only: the resolved state shape. Exposed so consumers can
   * derive companion hook argument types (`useValues<typeof stream>`)
   * without plumbing `T` through their component hierarchy.
   *
   * @internal
   */
  readonly "~stateType"?: StateType;
  /**
   * The root message projection. Assembled from two sources and
   * merged in real time:
   *
   *  1. `messages`-channel deltas — token-level streaming events
   *     (`message-start`, `content-block-delta`, `message-finish`)
   *     emitted by the runtime. These drive live, token-by-token
   *     updates.
   *  2. `values.messages` snapshots — the authoritative ordering
   *     and any messages the agent produces without token streaming
   *     (human turns, tool results, echoes from subagents).
   *
   * If the backend only emits `values` events (no `messages`
   * channel), every message will appear fully-formed on each
   * values update rather than streaming. This is a backend/runtime
   * concern — the React layer faithfully renders whatever the
   * server sends.
   *
   * Equivalent to calling `useMessages(stream)` with no target.
   */
  readonly messages: BaseMessage[];
  /**
   * Root-namespace tool calls assembled from the `tools` channel.
   * Each entry is a fully parsed {@link AssembledToolCall} with
   * name, args, and id — suitable for rendering approval UIs or
   * forwarding to headless tool handlers.
   *
   * When the stream is typed with an agent brand or tool list,
   * entries are narrowed via {@link InferToolCalls}. Equivalent to
   * calling `useToolCalls(stream)` with no target.
   */
  readonly toolCalls: InferToolCalls<T>[];
  /**
   * All unresolved protocol interrupts observed on the root
   * namespace during the active thread. Populated from lifecycle /
   * input events and seeded on hydration from `thread.getState()`.
   * Cleared optimistically when a new run starts or an interrupt is
   * resolved via {@link respond}.
   */
  readonly interrupts: Interrupt<InterruptType>[];
  /**
   * Convenience alias for {@link interrupts}[0] — the primary
   * interrupt most UIs should act on when only one is pending.
   * `undefined` when no interrupt is active.
   */
  readonly interrupt: Interrupt<InterruptType> | undefined;
  /**
   * `true` while a run is active or being started on the current
   * thread. Driven by root-namespace lifecycle events (`running` →
   * `true`, terminal phases → `false`). Use this to disable submit
   * buttons and show in-flight spinners.
   */
  readonly isLoading: boolean;
  /**
   * `true` while the initial `thread.getState()` hydration for the
   * active thread is in flight. Distinct from {@link isLoading} —
   * thread loading covers the one-time fetch that seeds
   * {@link values} / {@link messages} before any user submit.
   */
  readonly isThreadLoading: boolean;
  /**
   * Promise that settles when the current thread's initial hydration
   * completes. Exposed so Suspense wrappers can `throw` it until the
   * first {@link StreamController.hydrate} call resolves (or rejects)
   * for the active thread. A fresh promise is installed on every
   * `switchThread`/`threadId` change.
   */
  readonly hydrationPromise: Promise<void>;
  /**
   * The last error observed on the active run or hydration attempt.
   * `undefined` when no error has occurred. Cleared optimistically
   * when a new {@link submit} starts.
   */
  readonly error: unknown;
  /**
   * Id of the thread the controller is bound to. `null` until the
   * first {@link submit} creates or selects a thread (or until an
   * explicit `threadId` option is provided and hydrated).
   */
  readonly threadId: string | null;

  // ----- always-on discovery -----
  /**
   * Subagents discovered on the root run. For DeepAgent-typed
   * streams the key set is narrowed to the subagent names declared
   * on the agent brand (`keyof InferSubagentStates<T>`).
   */
  readonly subagents: ReadonlyMap<
    keyof SubagentStates & string extends never
      ? string
      : keyof SubagentStates & string,
    SubagentDiscoverySnapshot
  >;
  /**
   * Subgraphs discovered on the root run.
   *
   * A namespace is classified as a subgraph iff at least one
   * strictly-deeper namespace has been observed with it as a prefix.
   * This is inferred from the lifecycle event stream — plain function
   * nodes (`orchestrator`, `writer` in the nested-stategraph example)
   * never appear here even though the server emits namespaced
   * lifecycle events for them. Promotion is monotonic and retroactive;
   * an entry appears as soon as the first descendant event lands.
   */
  readonly subgraphs: ReadonlyMap<string, SubgraphDiscoverySnapshot>;
  /**
   * Subgraphs indexed by the graph node that produced them
   * (`addNode("visualizer_0", …)`). Each value is an array because
   * parallel fan-outs and loops can spawn multiple invocations of
   * the same node; arrays preserve insertion order. Updates in
   * lock-step with {@link subgraphs}.
   */
  readonly subgraphsByNode: ReadonlyMap<
    string,
    readonly SubgraphDiscoverySnapshot[]
  >;

  // ----- imperatives -----
  /**
   * Dispatch a new run on the bound thread.
   *
   * `input` is typed as `Partial<StateType>` so IDE autocompletion
   * surfaces the state keys declared on the root hook.
   */
  submit(
    input: WidenUpdateMessages<Partial<StateType>> | null | undefined,
    options?: StreamSubmitOptions<StateType, ConfigurableType>
  ): Promise<void>;
  /**
   * Stop the active run on the current thread. By default cancels the
   * run server-side and disconnects the client; pass `{ cancel: false }`
   * or use {@link disconnect} for join/rejoin. Sets {@link isLoading} to
   * `false` immediately; {@link values} and {@link messages} are preserved.
   */
  stop(options?: StreamStopOptions): Promise<void>;
  /**
   * Disconnect the client without cancelling the run server-side.
   * Alias for `stop({ cancel: false })`.
   */
  disconnect(): Promise<void>;
  /**
   * Resume a pending protocol interrupt by sending a response payload
   * back to the interrupted namespace.
   *
   * When `options.interruptId` is omitted, walks `getThread()?.interrupts`
   * from newest to oldest and resumes the first not yet resolved by a prior
   * `respond()` call. That may be a root or subgraph interrupt and is
   * **not** necessarily {@link interrupt} (`interrupts[0]`, root-only).
   * Safe when exactly one interrupt is pending; otherwise pass an explicit
   * `options.interruptId` (and `options.namespace` for subgraph
   * interrupts).
   *
   * The server validates `namespace` against the pending interrupt. Root
   * interrupts use `namespace: []` (default when omitted). For subgraph
   * interrupts, copy `namespace` from `getThread()?.interrupts`.
   *
   * Pass `options.config` / `options.metadata` to fold run-level config
   * (model, user context, …) and metadata (trigger source, test flags,
   * …) into the resumed run, mirroring `submit()`.
   *
   * Pass `options.update` (and/or `options.goto`) to apply a state update
   * (and/or directed jump) in the **same superstep** as the resume — mapped
   * to LangGraph's `Command(resume, update, goto)`. The resumed run produces
   * a single checkpoint reflecting both, so a HITL card can push its message
   * into state at the moment it answers the interrupt (no separate state
   * write, no intermediate checkpoint, no flicker). Messages may be plain
   * dicts or `@langchain/core` `BaseMessage` instances (serialized like
   * `submit()`).
   *
   * @example
   * ```tsx
   * // Single pending interrupt
   * await stream.respond({ approved: true });
   * ```
   *
   * @example
   * ```tsx
   * // Resolve the interrupt AND push the card's message into state atomically
   * await stream.respond({ approved: true }, {
   *   update: { messages: [{ type: "ai", content: "Approved by reviewer." }] },
   * });
   * ```
   *
   * @example
   * ```tsx
   * // `update` also accepts BaseMessage instances, like `submit()`
   * import { AIMessage } from "@langchain/core/messages";
   * await stream.respond({ approved: true }, {
   *   update: { messages: [new AIMessage("Approved by reviewer.")] },
   * });
   * ```
   *
   * @example
   * ```tsx
   * // Resume carrying run config + metadata
   * await stream.respond({ approved: true }, {
   *   config: { configurable: { model: "gpt-4o" } },
   *   metadata: { source: "ui" },
   * });
   * ```
   *
   * @example
   * ```tsx
   * // Multiple root interrupts — one at a time
   * stream.interrupts.map((intr) => (
   *   <button
   *     key={intr.id}
   *     onClick={() =>
   *       void stream.respond({ approved: true }, { interruptId: intr.id! })
   *     }
   *   />
   * ));
   * ```
   *
   * @example
   * ```tsx
   * // Subgraph interrupt — namespace from `getThread()`
   * const thread = stream.getThread();
   * thread?.interrupts.map((entry) => (
   *   <button
   *     key={entry.interruptId}
   *     onClick={() =>
   *       void stream.respond(buildResponse(entry.payload), {
   *         interruptId: entry.interruptId,
   *         namespace: entry.namespace,
   *       })
   *     }
   *   />
   * ));
   * ```
   *
   * To resume several interrupts pending at the same checkpoint in one
   * command, use {@link respondAll}.
   */
  respond(
    response: unknown,
    options?: StreamRespondOptions<ConfigurableType>
  ): Promise<void>;

  /**
   * Resume several pending interrupts at the same checkpoint in a single
   * command — required when a run pauses on multiple interrupts at once
   * (e.g. parallel tool-authorization prompts), which sequential
   * {@link respond} calls cannot handle (the first resume starts a run,
   * leaving the rest with no interrupted run to respond to).
   *
   * `responsesById` maps each pending `interruptId` to its response, so
   * different interrupts can receive different payloads. To send the same
   * payload to several interrupts, build the map with that value for each
   * id, e.g. `Object.fromEntries(ids.map((id) => [id, response]))`.
   *
   * Pass `options.config` / `options.metadata` to fold run-level config
   * and metadata into the single run that services the batched resume,
   * mirroring `submit()`.
   *
   * @example
   * ```tsx
   * // Distinct payloads per interrupt
   * await stream.respondAll({
   *   [interruptA.id]: { approved: true },
   *   [interruptB.id]: { approved: false },
   * });
   * ```
   *
   * @example
   * ```tsx
   * // Same payload to every pending interrupt
   * await stream.respondAll(
   *   Object.fromEntries(stream.interrupts.map((i) => [i.id!, { approved: true }])),
   * );
   * ```
   */
  respondAll(
    responsesById: Record<string, unknown>,
    options?: StreamRespondAllOptions<ConfigurableType>
  ): Promise<void>;

  // ----- identity -----
  /** LangGraph SDK client used to construct thread streams. */
  readonly client: Client;
  /** Assistant id the thread is bound to for its lifetime. */
  readonly assistantId: string;

  /**
   * Returns the bound {@link ThreadStream}, if one exists (`undefined`
   * until the thread is hydrated or the first submit completes). Prefer
   * the projections and selector hooks for UI work; use this for
   * low-level protocol access (raw subscriptions, state commands, etc.).
   */
  getThread(): ThreadStream | undefined;

  /** @internal Used by selector hooks (`useMessages`, `useToolCalls`, …). */
  readonly [STREAM_CONTROLLER]: StreamController<
    StateType,
    InterruptType,
    ConfigurableType
  >;
}

/**
 * Erased stream handle useful as a parameter type for helpers and
 * wrapper components that pass a `stream` through to selector hooks
 * (`useMessages`, `useChannel`, …) without reading `values` directly.
 *
 * Any fully-typed `UseStreamReturn<T, I, C>` is assignable to
 * `AnyStream`. Widening the three generic slots to `any` is **not**
 * enough on its own: members whose types are computed from `T` in
 * covariant positions don't collapse to a top type under `any`. In
 * particular `toolCalls: InferToolCalls<any>[]` resolves to
 * `AssembledToolCall<string, …, never>[]` — the `never` output slot is
 * *narrower* than a concrete handle's `AssembledToolCall<…, unknown>[]`,
 * so the concrete handle fails to assign and every `useToolCalls(stream)`
 * call would need an `as AnyStream` cast. `values` / `~stateType`
 * (computed via `InferStateType<any>`) have the same hazard. We override
 * those members with their widest forms so the erased handle is a true
 * supertype of every concrete `UseStreamReturn`.
 *
 * @example
 * ```tsx
 * function SubgraphCard({ stream, subgraph }: {
 *   stream: AnyStream;
 *   subgraph: SubgraphDiscoverySnapshot;
 * }) {
 *   const messages = useMessages(stream, subgraph);
 *   return <Feed messages={messages} />;
 * }
 * ```
 */
export type AnyStream = Omit<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  UseStreamReturn<any, any, any>,
  "toolCalls" | "values" | "~stateType"
> & {
  readonly toolCalls: AssembledToolCall[];
  readonly values: unknown;
  readonly "~stateType"?: unknown;
};

/**
 * React binding for the v2-native stream runtime.
 *
 * `useStream` exposes three always-on projections
 * (`values` / `messages` / `toolCalls`) at the thread root plus
 * cheap discovery maps for subagents / subgraphs. Scoped views of
 * subagents, subgraphs, or any namespaced projection are surfaced via
 * the companion selector hooks:
 *
 * ```tsx
 * const stream = useStream({ assistantId: "deep-agent" });
 *
 * // Root messages — always on, already class instances.
 * stream.messages.map((m) => <Bubble key={m.id} msg={m} />);
 *
 * // Subagent view — mount = subscribe, unmount = unsubscribe.
 * function SubagentCard({ subagent }) {
 *   const messages = useMessages(stream, subagent);
 *   const toolCalls = useToolCalls(stream, subagent);
 *   return <>{messages.map(...)}</>;
 * }
 * ```
 *
 * The first generic accepts either a plain state type
 * (`useStream<MyState>()`) *or* a compiled graph type
 * (`useStream<typeof agent>()`); in the latter case the
 * state shape is unwrapped from the graph via {@link InferStateType}, so
 * `stream.values` is always typed as the state, never as the graph
 * class itself.
 */
export function useStream<
  T = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
>(
  options: UseStreamOptions<InferStateType<T>>
): UseStreamReturn<T, InterruptType, ConfigurableType> {
  type StateType = InferStateType<T>;
  // Branch-stable narrowings for each code path. The custom-adapter
  // branch can skip LGP client construction entirely, which keeps
  // bundles that *only* use a custom adapter free of the default
  // `sse`/`websocket` transport factories (tree-shaken).
  // Treat the options as a flat bag here — the discriminated union
  // exists to give call sites a nice error message, but at runtime
  // both branches are reachable through the same set of fields.
  interface OptionsBag {
    assistantId?: string;
    threadId?: string | null;
    client?: Client;
    apiUrl?: string;
    apiKey?: string;
    callerOptions?: ClientConfig["callerOptions"];
    defaultHeaders?: ClientConfig["defaultHeaders"];
    transport?: "sse" | "websocket" | AgentServerAdapter;
    fetch?: typeof fetch;
    webSocketFactory?: (url: string) => WebSocket;
    onThreadId?: (threadId: string) => void;
    onCreated?: (info: RunExecutionInfo) => void;
    onCompleted?: (info: RunCompletedInfo) => void;
    initialValues?: StateType;
    messagesKey?: string;
    optimistic?: boolean;
  }
  const asBag = options as OptionsBag;
  // Narrow once: a non-string `transport` is a custom adapter; anything
  // else (`"sse"` / `"websocket"` / `undefined`) is a built-in.
  const hasCustomAdapter =
    asBag.transport != null && typeof asBag.transport !== "string";
  const transport = asBag.transport;

  // Stable client across re-renders.
  //
  // A `useMemo` is NOT a stability guarantee — React may drop a memo
  // cache even when its deps are unchanged. If the client is dropped,
  // the controller below (which depends on it) is recreated too, and a
  // fresh controller re-fires its constructor hydrate: a *duplicate*
  // `getState` + `getHistory`. A ref is never dropped, so the client
  // stays referentially stable until its config actually changes.
  const resolvedApiUrl = resolveClientApiUrl({
    apiUrl: asBag.apiUrl,
    transport: hasCustomAdapter ? transport : asBag.transport,
  });
  const clientDeps = [
    asBag.client,
    resolvedApiUrl,
    asBag.apiKey,
    asBag.callerOptions,
    asBag.defaultHeaders,
  ] as const;
  const clientRef = useRef<{
    deps: typeof clientDeps;
    client: Client;
  } | null>(null);
  if (
    clientRef.current == null ||
    clientRef.current.deps.some((dep, i) => dep !== clientDeps[i])
  ) {
    clientRef.current = {
      deps: clientDeps,
      client:
        asBag.client ??
        (new ClientCtor({
          apiUrl: resolvedApiUrl,
          apiKey: asBag.apiKey,
          callerOptions: asBag.callerOptions,
          defaultHeaders: asBag.defaultHeaders,
        }) as unknown as Client),
    };
  }
  const client = clientRef.current.client;

  // Custom adapters may omit `assistantId`; the controller still
  // requires one so it has something to forward to `threads.stream`.
  // `"_"` is the well-known sentinel for "adapter doesn't care".
  const sentinel = "_";
  const assistantId =
    "assistantId" in options ? (options.assistantId ?? sentinel) : sentinel;

  // Stable controller across re-renders (same rationale as `clientRef`).
  //
  // The controller self-hydrates in its constructor, so recreating it
  // re-issues `getState` + `getHistory`. Pinning it in a ref guarantees
  // a single hydrate per mount even when React re-renders or re-runs the
  // component body (a dropped `useMemo` here was the source of duplicate
  // hydrate fetches). `threadId` is deliberately NOT part of the
  // identity — the controller persists across thread switches and
  // self-create (`onThreadId`) so in-flight runs are never orphaned;
  // thread changes rebind in-place via `hydrate()` in the effect below.
  // Recreated only when its identity inputs change; the previous
  // instance is disposed by the `activate()` effect when `controller`
  // changes.
  const controllerDeps = [client, assistantId, transport] as const;
  const controllerRef = useRef<{
    deps: typeof controllerDeps;
    controller: StreamController<StateType, InterruptType, ConfigurableType>;
  } | null>(null);
  if (
    controllerRef.current == null ||
    controllerRef.current.deps.some((dep, i) => dep !== controllerDeps[i])
  ) {
    controllerRef.current = {
      deps: controllerDeps,
      controller: new StreamController<
        StateType,
        InterruptType,
        ConfigurableType
      >({
        assistantId,
        // Cast: the runtime `Client` is state-shape agnostic, but the
        // controller declares `client: Client<StateType>` so its own
        // typings line up. Tightening `submit`'s `input` parameter to
        // `Partial<StateType>` surfaced this variance mismatch that
        // was previously masked — the cast is equivalent to the
        // ClientCtor cast above.
        client: client as unknown as Client<StateType>,
        threadId: options.threadId ?? null,
        transport,
        fetch: hasCustomAdapter ? undefined : asBag.fetch,
        webSocketFactory: hasCustomAdapter ? undefined : asBag.webSocketFactory,
        onThreadId: options.onThreadId,
        onCreated: options.onCreated,
        onCompleted: options.onCompleted,
        initialValues: options.initialValues,
        messagesKey: options.messagesKey,
        optimistic: asBag.optimistic,
      }),
    };
  }
  const controller = controllerRef.current.controller;

  // Rehydrate on threadId change. The initial hydrate is fired
  // synchronously inside the controller constructor so Suspense
  // callers don't deadlock waiting for an effect that never runs
  // (throwing `hydrationPromise` during render unmounts the subtree
  // before effects fire). We only re-hydrate here when the threadId
  // prop changes after the controller was already constructed with a
  // matching id.
  const lastHydratedRef = useRef<{
    controller: StreamController<StateType, InterruptType, ConfigurableType>;
    threadId: string | null;
  } | null>(null);
  useEffect(() => {
    const target = options.threadId ?? null;
    const last = lastHydratedRef.current;
    if (last?.controller !== controller) {
      // Freshly constructed controller already seeded the hydrate in
      // its constructor — record the id and skip the redundant call.
      lastHydratedRef.current = { controller, threadId: target };
      return;
    }
    if (last.threadId === target) return;
    lastHydratedRef.current = { controller, threadId: target };
    void controller.hydrate(target);
  }, [controller, options.threadId]);

  // Dispose on unmount / controller swap.
  //
  // We use `controller.activate()` instead of a naive
  // `() => controller.dispose()` cleanup because React 18+
  // `<StrictMode>` in dev mounts → unmounts → remounts components
  // synchronously to surface cleanup bugs. A naive cleanup would
  // permanently tear the controller down on that first synthetic
  // unmount and turn every subsequent `submit()` into a silent
  // no-op. `activate()` defers disposal to the next microtask and
  // cancels it if the effect re-runs — which is exactly the
  // StrictMode remount pattern.
  useEffect(() => controller.activate(), [controller]);

  // Headless-tool handling: if the caller supplied `tools`, watch the
  // root `values.__interrupt__` channel for protocol interrupts that
  // target a registered tool, invoke the handler, and auto-resume the
  // run. Ref-tracks the ids we've already handled so the same
  // interrupt on a subsequent render is never executed twice
  // (StrictMode safe).
  const handledToolsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    handledToolsRef.current.clear();
  }, [options.threadId]);
  const tools = options.tools;
  const onTool = options.onTool;
  // Subscribe to values + interrupt updates via the root store so the
  // effect re-runs whenever a protocol interrupt lands or the
  // `__interrupt__` key is projected into values, not only on hook
  // re-render. Prefer protocol interrupts from `rootStore.interrupts`
  // (`input.requested` events) because their ids are accepted directly
  // by `Command({ resume })`; fall back to `values.__interrupt__` for
  // older streams that only expose interrupts through values.
  const rootValuesForTools = useSyncExternalStore<StateType>(
    controller.rootStore.subscribe,
    () => controller.rootStore.getSnapshot().values,
    () => controller.rootStore.getSnapshot().values
  );
  const rootInterruptsForTools = useSyncExternalStore<
    readonly Interrupt<InterruptType>[]
  >(
    controller.rootStore.subscribe,
    () => controller.rootStore.getSnapshot().interrupts,
    () => controller.rootStore.getSnapshot().interrupts
  );
  useEffect(() => {
    if (!tools?.length) return;
    const valuesBag = rootValuesForTools as unknown as Record<string, unknown>;
    const protocolInterrupts = rootInterruptsForTools as unknown as Interrupt[];
    const valuesInterrupts = Array.isArray(valuesBag?.__interrupt__)
      ? (valuesBag.__interrupt__ as Interrupt[])
      : [];
    const headlessInterrupts =
      protocolInterrupts.length > 0 ? protocolInterrupts : valuesInterrupts;
    if (headlessInterrupts.length === 0) return;
    flushPendingHeadlessToolInterrupts(
      { ...valuesBag, __interrupt__: headlessInterrupts },
      tools,
      handledToolsRef.current,
      {
        onTool,
        defer: (run) => {
          void Promise.resolve().then(run);
        },
        resumeSubmit: (command) =>
          applyHeadlessToolResumeCommand(controller, command),
      }
    );
  }, [controller, tools, onTool, rootValuesForTools, rootInterruptsForTools]);

  const root = useSyncExternalStore<RootSnapshot<StateType, InterruptType>>(
    controller.rootStore.subscribe,
    controller.rootStore.getSnapshot,
    controller.rootStore.getSnapshot
  );
  const subagents = useSyncExternalStore<SubagentMap>(
    controller.subagentStore.subscribe,
    controller.subagentStore.getSnapshot,
    controller.subagentStore.getSnapshot
  );
  const subgraphs = useSyncExternalStore<SubgraphMap>(
    controller.subgraphStore.subscribe,
    controller.subgraphStore.getSnapshot,
    controller.subgraphStore.getSnapshot
  );
  const subgraphsByNode = useSyncExternalStore<SubgraphByNodeMap>(
    controller.subgraphByNodeStore.subscribe,
    controller.subgraphByNodeStore.getSnapshot,
    controller.subgraphByNodeStore.getSnapshot
  );

  return useMemo<UseStreamReturn<T, InterruptType, ConfigurableType>>(() => {
    const userFacingInterrupts = filterOutHeadlessToolInterrupts(
      root.interrupts
    );
    return {
      values: root.values,
      messages: root.messages,
      toolCalls: root.toolCalls as InferToolCalls<T>[],
      interrupts: userFacingInterrupts,
      interrupt: userFacingInterrupts[0],
      isLoading: root.isLoading,
      isThreadLoading: root.isThreadLoading,
      hydrationPromise: controller.hydrationPromise,
      error: root.error,
      threadId: root.threadId,
      subagents: subagents as UseStreamReturn<
        T,
        InterruptType,
        ConfigurableType
      >["subagents"],
      subgraphs,
      subgraphsByNode,
      submit: (input, submitOptions) => controller.submit(input, submitOptions),
      stop: (options) => controller.stop(options),
      disconnect: () => controller.disconnect(),
      respond: (response, options) => controller.respond(response, options),
      respondAll: (responsesById, options) =>
        controller.respondAll(responsesById, options),
      getThread: () => controller.getThread(),
      client,
      assistantId,
      [STREAM_CONTROLLER]: controller,
    } as UseStreamReturn<T, InterruptType, ConfigurableType>;
  }, [
    root,
    subagents,
    subgraphs,
    subgraphsByNode,
    controller,
    client,
    assistantId,
  ]);
}

/**
 * Convenience alias for the fully-resolved stream handle type.
 */
export type UseStreamResult<
  T = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
> = UseStreamReturn<T, InterruptType, ConfigurableType>;

/**
 * Helper used by the selector hooks to reach the underlying
 * {@link ChannelRegistry} from a stream handle. Kept internal —
 * application code should call `useMessages`, `useToolCalls`, etc.
 * instead of reading this directly.
 *
 * @internal
 */
export function getRegistry(stream: AnyStream): ChannelRegistry {
  return stream[STREAM_CONTROLLER].registry;
}

export type { ThreadStream };
