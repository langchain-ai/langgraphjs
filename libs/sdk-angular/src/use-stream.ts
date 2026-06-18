import {
  DestroyRef,
  computed,
  effect,
  inject,
  isSignal,
  signal,
  untracked,
  type Signal,
} from "@angular/core";
import type { BaseMessage } from "@langchain/core/messages";
import type { Client, Interrupt } from "@langchain/langgraph-sdk";
import {
  applyHeadlessToolResumeCommand,
  filterOutHeadlessToolInterrupts,
  flushPendingHeadlessToolInterrupts,
  scheduleCoalescedHeadlessToolFlush,
  type AnyHeadlessToolImplementation,
  type OnToolCallback,
} from "@langchain/langgraph-sdk";
import {
  Client as ClientCtor,
  resolveClientApiUrl,
  type ClientConfig,
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
  type InferToolCalls,
  type InferSubagentStates,
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

type AngularThreadId = string | null | Signal<string | null | undefined>;

export type AgentServerOptions<StateType extends object> =
  StreamAgentServerOptions<StateType, AngularThreadId>;

export type CustomAdapterOptions<StateType extends object> =
  StreamCustomAdapterOptions<StateType, AngularThreadId, string>;

export type UseStreamOptions<
  StateType extends object = Record<string, unknown>,
> = StreamUseStreamOptions<
  StateType,
  AngularThreadId,
  string | undefined,
  string | undefined,
  string
>;

/**
 * Private field on the handle that carries the
 * {@link StreamController} reference. Selector primitives read this
 * to reach the shared {@link ChannelRegistry}. Use the companion
 * `inject*` selectors (`injectMessages`, `injectToolCalls`,
 * `injectValues`, …) instead of reading this directly.
 */
export const STREAM_CONTROLLER: unique symbol = Symbol.for(
  "@langchain/angular/controller"
);

/**
 * Return shape of {@link useStream} — the Angular `StreamApi`.
 *
 * Reactivity primitives follow Angular conventions:
 *
 *  - Data projections are `Signal<T>`; call them as functions in
 *    templates (`stream.messages()`). They are snapshots — never
 *    mutate the returned arrays / maps.
 *  - Imperative methods (`submit` / `stop` / `respond`) are plain
 *    functions. No `WritableSignal`s are exposed on the root handle.
 *  - Identity values captured at construction time (`client`,
 *    `assistantId`) are exposed as plain values; remount the
 *    component to swap them.
 */
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
   * on token-level deltas: if you render `stream.values().messages`
   * directly you'll see full turns appear at once instead of
   * streaming token-by-token. Use {@link messages} (or
   * `injectMessages`) for the token-streamed view.
   *
   * Equivalent to calling `injectValues(stream)`.
   */
  readonly values: Signal<StateType>;
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
   * concern — the Angular layer faithfully renders whatever the
   * server sends.
   *
   * Equivalent to calling `injectMessages(stream)` with no target.
   */
  readonly messages: Signal<BaseMessage[]>;
  /**
   * Root-namespace tool calls assembled from the `tools` channel.
   * Each entry is a fully parsed {@link AssembledToolCall} with
   * name, args, and id — suitable for rendering approval UIs or
   * forwarding to headless tool handlers.
   *
   * When the stream is typed with an agent brand or tool list,
   * entries are narrowed via {@link InferToolCalls}. Equivalent to
   * calling `injectToolCalls(stream)` with no target.
   */
  readonly toolCalls: Signal<InferToolCalls<T>[]>;
  /**
   * All unresolved protocol interrupts observed on the root
   * namespace during the active thread. Populated from lifecycle /
   * input events and seeded on hydration from `thread.getState()`.
   * Cleared optimistically when a new run starts or an interrupt is
   * resolved via {@link respond}.
   */
  readonly interrupts: Signal<Interrupt<InterruptType>[]>;
  /**
   * Convenience alias for {@link interrupts}[0] — the primary
   * interrupt most UIs should act on when only one is pending.
   * `undefined` when no interrupt is active.
   */
  readonly interrupt: Signal<Interrupt<InterruptType> | undefined>;
  /**
   * `true` while a run is active or being started on the current
   * thread. Driven by root-namespace lifecycle events (`running` →
   * `true`, terminal phases → `false`). Use this to disable submit
   * buttons and show in-flight spinners.
   */
  readonly isLoading: Signal<boolean>;
  /**
   * `true` while the initial `thread.getState()` hydration for the
   * active thread is in flight. Distinct from {@link isLoading} —
   * thread loading covers the one-time fetch that seeds
   * {@link values} / {@link messages} before any user submit.
   */
  readonly isThreadLoading: Signal<boolean>;
  /**
   * The last error observed on the active run or hydration attempt.
   * `undefined` when no error has occurred. Cleared optimistically
   * when a new {@link submit} starts.
   */
  readonly error: Signal<unknown>;
  /**
   * Id of the thread the controller is bound to. `null` until the
   * first {@link submit} creates or selects a thread (or until an
   * explicit `threadId` option is provided and hydrated).
   */
  readonly threadId: Signal<string | null>;
  /**
   * Promise that settles when the active thread's initial hydration
   * completes. Exposed so SSR/render-before-flush pipelines can
   * `await stream.hydrationPromise()` before serialising. A fresh
   * promise is installed on every `threadId` change.
   */
  readonly hydrationPromise: Signal<Promise<void>>;

  // ----- always-on discovery -----
  /**
   * Subagents discovered on the root run. For DeepAgent-typed
   * streams the key set is narrowed to the subagent names declared
   * on the agent brand (`keyof InferSubagentStates<T>`).
   */
  readonly subagents: Signal<
    ReadonlyMap<
      keyof SubagentStates & string extends never
        ? string
        : keyof SubagentStates & string,
      SubagentDiscoverySnapshot
    >
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
  readonly subgraphs: Signal<ReadonlyMap<string, SubgraphDiscoverySnapshot>>;
  /**
   * Subgraphs indexed by the graph node that produced them
   * (`addNode("visualizer_0", …)`). Each value is an array because
   * parallel fan-outs and loops can spawn multiple invocations of
   * the same node; arrays preserve insertion order. Updates in
   * lock-step with {@link subgraphs}.
   */
  readonly subgraphsByNode: Signal<
    ReadonlyMap<string, readonly SubgraphDiscoverySnapshot[]>
  >;

  // ----- imperatives -----
  /**
   * Dispatch a new run on the bound thread.
   *
   * `input` is typed as `Partial<StateType>` so IDE autocompletion
   * surfaces the state keys declared on the root primitive.
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
   * **not** necessarily {@link interrupt} (`interrupts()[0]`, root-only).
   * Safe when exactly one interrupt is pending; otherwise pass an explicit
   * `options.interruptId` (and `options.namespace` for subgraph
   * interrupts).
   *
   * The server validates `namespace` against the pending interrupt. Root
   * interrupts use `namespace: []` (default when omitted). For subgraph
   * interrupts, copy `namespace` from `getThread()?.interrupts`.
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
   * ```ts
   * // Single pending interrupt
   * await stream.respond({ approved: true });
   * ```
   *
   * @example
   * ```ts
   * // Resolve the interrupt AND push the card's message into state atomically
   * await stream.respond({ approved: true }, {
   *   update: { messages: [{ type: "ai", content: "Approved by reviewer." }] },
   * });
   * ```
   *
   * @example
   * ```ts
   * // `update` also accepts BaseMessage instances, like `submit()`
   * import { AIMessage } from "@langchain/core/messages";
   * await stream.respond({ approved: true }, {
   *   update: { messages: [new AIMessage("Approved by reviewer.")] },
   * });
   * ```
   *
   * @example
   * ```ts
   * // Multiple root interrupts
   * for (const intr of stream.interrupts()) {
   *   await stream.respond(decide(intr.value), { interruptId: intr.id! });
   * }
   * ```
   *
   * @example
   * ```ts
   * // Subgraph interrupt — namespace from `getThread()`
   * const thread = stream.getThread();
   * for (const entry of thread?.interrupts ?? []) {
   *   await stream.respond(buildResponse(entry.payload), {
   *     interruptId: entry.interruptId,
   *     namespace: entry.namespace,
   *   });
   * }
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
   * {@link respond} calls cannot handle. `responsesById` maps each pending
   * `interruptId` to its response, so different interrupts can receive
   * different payloads. Pass `options.config` / `options.metadata` to fold
   * run-level config and metadata into the resumed run, mirroring
   * `submit()`.
   *
   * @example
   * ```ts
   * await stream.respondAll({
   *   [interruptA.id]: { approved: true },
   *   [interruptB.id]: { approved: false },
   * });
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
   * the projections and selector primitives for UI work; use this for
   * low-level protocol access (raw subscriptions, state commands, etc.).
   */
  getThread(): ThreadStream | undefined;

  /** @internal Used by selector primitives. */
  readonly [STREAM_CONTROLLER]: StreamController<
    StateType,
    InterruptType,
    ConfigurableType
  >;
}

/**
 * Erased handle useful as a parameter type for helper components that
 * pass a `stream` through to selector primitives without reading
 * `values` directly. Mirrors the React/Vue `AnyStream` alias.
 *
 * Widening the generic slots to `any` is **not** enough on its own:
 * members computed from `T` in covariant positions don't collapse to a
 * top type under `any`. `toolCalls` resolves to
 * `Signal<AssembledToolCall<…, never>[]>` — the `never` output slot is
 * narrower than a concrete handle's `…, unknown`, so a fully-typed
 * `useStream<typeof agent>()` handle would fail to assign and every
 * `injectToolCalls(stream)` call would need an `as AnyStream` cast.
 * Override `toolCalls` / `values` (keeping the `Signal` wrapper) with
 * their widest forms so the erased handle is a true supertype of every
 * concrete `UseStreamReturn`.
 */
export type AnyStream = Omit<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  UseStreamReturn<any, any, any>,
  "toolCalls" | "values"
> & {
  readonly toolCalls: Signal<AssembledToolCall[]>;
  readonly values: Signal<unknown>;
};

/**
 * Convenience alias — the fully-resolved return type of
 * {@link useStream} for a given source type `T`.
 */
export type StreamApi<
  T = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
> = UseStreamReturn<T, InterruptType, ConfigurableType>;

/**
 * React-compatible alias for the fully-resolved stream handle type.
 * Angular docs prefer {@link StreamApi}, but shared libraries can use
 * this name across framework bindings.
 */
export type UseStreamResult<
  T = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
> = UseStreamReturn<T, InterruptType, ConfigurableType>;

/**
 * Framework-free factory that constructs a {@link StreamController}
 * and wraps its stores in Angular Signals. Callers must supply the
 * {@link DestroyRef} that owns the controller's lifetime — it's
 * already captured by the public `injectStream` helper.
 *
 * Exported for advanced callers (e.g. testing utilities, custom
 * factories) that prefer to manage injection scope themselves.
 */
export function useStream<
  T = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
>(
  options: UseStreamOptions<InferStateType<T>>,
  destroyRef?: DestroyRef
): UseStreamReturn<T, InterruptType, ConfigurableType> {
  type StateType = InferStateType<T>;

  interface OptionsBag {
    assistantId?: string;
    threadId?: string | null | Signal<string | null | undefined>;
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
    tools?: AnyHeadlessToolImplementation[];
    onTool?: OnToolCallback;
    optimistic?: boolean;
  }
  const asBag = options as OptionsBag;

  const hasCustomAdapter =
    asBag.transport != null && typeof asBag.transport !== "string";
  const transport = asBag.transport;

  const client: Client =
    asBag.client ??
    (new ClientCtor({
      apiUrl: resolveClientApiUrl({
        apiUrl: asBag.apiUrl,
        transport: hasCustomAdapter ? transport : asBag.transport,
      }),
      apiKey: asBag.apiKey,
      callerOptions: asBag.callerOptions,
      defaultHeaders: asBag.defaultHeaders,
    }) as unknown as Client);

  // Custom adapters may omit `assistantId`; the controller still
  // requires one so it has something to forward to `threads.stream`.
  const sentinel = "_";
  const assistantId =
    "assistantId" in options ? (options.assistantId ?? sentinel) : sentinel;

  // Normalize threadId input to a signal — callers may pass plain
  // values, nulls, or their own signals.
  const threadIdInput: Signal<string | null> = (() => {
    const raw = asBag.threadId;
    if (isSignal(raw)) {
      return computed(
        () => (raw as Signal<string | null | undefined>)() ?? null
      );
    }
    const initial: string | null = (raw as string | null | undefined) ?? null;
    return signal(initial) as unknown as Signal<string | null>;
  })();

  const controller = new StreamController<
    StateType,
    InterruptType,
    ConfigurableType
  >({
    assistantId,
    // Cast: the runtime `Client` is state-shape agnostic, but the
    // controller declares `client: Client<StateType>` for its own
    // typings. Same cast is applied in the React/Vue bindings.
    client: client as unknown as Client<StateType>,
    threadId: untracked(() => threadIdInput()),
    transport,
    fetch: hasCustomAdapter ? undefined : asBag.fetch,
    webSocketFactory: hasCustomAdapter ? undefined : asBag.webSocketFactory,
    onThreadId: options.onThreadId,
    onCreated: options.onCreated,
    onCompleted: options.onCompleted,
    initialValues: options.initialValues,
    messagesKey: options.messagesKey,
    optimistic: asBag.optimistic,
  });

  // Deferred dispose — matches the React `useEffect(() =>
  // controller.activate())` and Vue `onScopeDispose(deactivate)`
  // patterns. HMR / scope-reuse scenarios stay clean because
  // `activate()` cancels the pending dispose if the scope survives.
  const deactivate = controller.activate();
  const ref = destroyRef ?? inject(DestroyRef);
  ref.onDestroy(deactivate);

  // ─── Reactivity bridge: StreamStore → Signal ────────────────────────
  function bindStore<S>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => S
  ): Signal<S> {
    const s = signal<S>(getSnapshot());
    const unsubscribe = subscribe(() => {
      s.set(getSnapshot());
    });
    ref.onDestroy(unsubscribe);
    return computed(() => s());
  }

  const rootSignal = bindStore<RootSnapshot<StateType, InterruptType>>(
    controller.rootStore.subscribe,
    controller.rootStore.getSnapshot
  );
  const subagentSignal = bindStore<SubagentMap>(
    controller.subagentStore.subscribe,
    controller.subagentStore.getSnapshot
  );
  const subgraphSignal = bindStore<SubgraphMap>(
    controller.subgraphStore.subscribe,
    controller.subgraphStore.getSnapshot
  );
  const subgraphByNodeSignal = bindStore<SubgraphByNodeMap>(
    controller.subgraphByNodeStore.subscribe,
    controller.subgraphByNodeStore.getSnapshot
  );

  const values = computed(() => rootSignal().values);
  const messages = computed(() => rootSignal().messages);
  const toolCalls = computed(
    () => rootSignal().toolCalls as InferToolCalls<T>[]
  );
  const interrupts = computed(() =>
    filterOutHeadlessToolInterrupts(rootSignal().interrupts)
  );
  const interrupt = computed(() => interrupts()[0]);
  const isLoading = computed(() => rootSignal().isLoading);
  const isThreadLoading = computed(() => rootSignal().isThreadLoading);
  const error = computed(() => rootSignal().error);
  const threadId = computed(() => rootSignal().threadId);

  // `hydrationPromise` is a property on the controller that gets
  // swapped on every `hydrate()` call. Exposing it as a signal lets
  // templates `await stream.hydrationPromise()` reactively; we
  // refresh the reference when the root store settles a new promise.
  const hydrationPromise = computed(() => {
    rootSignal();
    return controller.hydrationPromise;
  });

  // ─── threadId reactivity ────────────────────────────────────────────
  //
  // Re-hydrate whenever the caller's threadId input changes after
  // construction. The initial hydrate already fired synchronously in
  // the controller constructor, so we compare against the snapshot
  // captured at construction time rather than blindly skipping the
  // first run — in Angular, `@Input()` bindings apply *between*
  // construction and the first effect tick, so the first read can
  // legitimately be a different (updated) value that needs to
  // hydrate.
  const initialThreadId = untracked(() => threadIdInput()) ?? null;
  let lastAppliedThreadId: string | null = initialThreadId;
  effect(() => {
    const next = threadIdInput() ?? null;
    if (next === lastAppliedThreadId) return;
    lastAppliedThreadId = next;
    untracked(() => {
      void controller.hydrate(next);
    });
  });

  // ─── Headless-tool handling ─────────────────────────────────────────
  const tools = options.tools;
  const onTool = options.onTool;
  if (tools?.length) {
    const handledTools = new Set<string>();

    // Clear the dedup set whenever the thread id changes.
    effect(() => {
      threadIdInput();
      untracked(() => handledTools.clear());
    });

    effect(() => {
      rootSignal();
      untracked(() => {
        scheduleCoalescedHeadlessToolFlush(handledTools, () => {
          const snapshot = rootSignal();
          const bag = snapshot.values as unknown as Record<string, unknown>;
          const protocolInterrupts =
            snapshot.interrupts as unknown as Interrupt[];
          const valuesInterrupts = Array.isArray(bag?.__interrupt__)
            ? (bag.__interrupt__ as Interrupt[])
            : [];
          const headlessInterrupts =
            protocolInterrupts.length > 0
              ? protocolInterrupts
              : valuesInterrupts;
          if (headlessInterrupts.length === 0) return;
          flushPendingHeadlessToolInterrupts(
            { ...bag, __interrupt__: headlessInterrupts },
            tools,
            handledTools,
            {
              onTool,
              defer: (run) => {
                void Promise.resolve().then(run);
              },
              resumeSubmit: (command) =>
                applyHeadlessToolResumeCommand(controller, command),
            }
          );
        });
      });
    });
  }

  const handle: UseStreamReturn<T, InterruptType, ConfigurableType> = {
    values: values as UseStreamReturn<
      T,
      InterruptType,
      ConfigurableType
    >["values"],
    messages,
    toolCalls,
    interrupts,
    interrupt,
    isLoading,
    isThreadLoading,
    error,
    threadId,
    hydrationPromise,
    subagents: subagentSignal as UseStreamReturn<
      T,
      InterruptType,
      ConfigurableType
    >["subagents"],
    subgraphs: subgraphSignal,
    subgraphsByNode: subgraphByNodeSignal,
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
  };

  return handle;
}

/**
 * Helper used by the selector primitives to reach the underlying
 * {@link ChannelRegistry} from a stream handle. Kept internal —
 * application code should call `injectMessages`, `injectToolCalls`,
 * etc. instead of reading this directly.
 *
 * @internal
 */
export function getRegistry(stream: AnyStream): ChannelRegistry {
  return stream[STREAM_CONTROLLER].registry;
}

export type { ThreadStream };
