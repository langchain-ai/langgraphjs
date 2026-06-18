import {
  computed,
  onScopeDispose,
  readonly,
  shallowRef,
  toValue,
  watch,
  type ComputedRef,
  type MaybeRefOrGetter,
  type ShallowRef,
} from "vue";
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
import { inject } from "vue";
import { LANGCHAIN_OPTIONS } from "./context.js";

type VueThreadId = MaybeRefOrGetter<string | null | undefined>;
type VueApiString = MaybeRefOrGetter<string | undefined>;

export type AgentServerOptions<StateType extends object> =
  StreamAgentServerOptions<StateType, VueThreadId, VueApiString, VueApiString>;

export type CustomAdapterOptions<StateType extends object> =
  StreamCustomAdapterOptions<StateType, VueThreadId, string>;

export type UseStreamOptions<
  StateType extends object = Record<string, unknown>,
> = StreamUseStreamOptions<
  StateType,
  VueThreadId,
  VueApiString,
  VueApiString,
  string
>;

/**
 * Private field on the handle that carries the {@link StreamController}
 * reference. Selector composables read this to reach the shared
 * {@link ChannelRegistry}. Use the selector composables (`useMessages`,
 * `useToolCalls`, `useValues`, …) instead of reading this directly.
 */
export const STREAM_CONTROLLER: unique symbol = Symbol.for(
  "@langchain/vue/controller"
);

/**
 * Vue binding return type for {@link useStream}.
 *
 * Reactive primitives follow Vue conventions:
 *
 *  - Data projections are `Readonly<ShallowRef<T>>` / `ComputedRef<T>`
 *    so templates auto-unwrap via `msg.value` in `<script setup>`
 *    and directly in templates. They are snapshots — never mutate.
 *  - Imperative methods (`submit` / `stop` / `respond`) are plain
 *    functions — no refs involved.
 *  - Identity values captured at setup time (`client` / `assistantId`)
 *    are exposed as plain values; if you need to swap the bound agent
 *    or client, remount the composable.
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
   * on token-level deltas: if you render `stream.values.value.messages`
   * directly you'll see full turns appear at once instead of
   * streaming token-by-token. Use {@link messages} (or
   * `useMessages`) for the token-streamed view.
   *
   * Equivalent to calling `useValues(stream)`.
   */
  readonly values: Readonly<ShallowRef<StateType>>;
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
   * concern — the Vue layer faithfully renders whatever the
   * server sends.
   *
   * Equivalent to calling `useMessages(stream)` with no target.
   */
  readonly messages: Readonly<ShallowRef<BaseMessage[]>>;
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
  readonly toolCalls: Readonly<ShallowRef<InferToolCalls<T>[]>>;
  /**
   * All unresolved protocol interrupts observed on the root
   * namespace during the active thread. Populated from lifecycle /
   * input events and seeded on hydration from `thread.getState()`.
   * Cleared optimistically when a new run starts or an interrupt is
   * resolved via {@link respond}.
   */
  readonly interrupts: Readonly<ShallowRef<Interrupt<InterruptType>[]>>;
  /**
   * Convenience alias for {@link interrupts}[0] — the primary
   * interrupt most UIs should act on when only one is pending.
   * `undefined` when no interrupt is active.
   */
  readonly interrupt: ComputedRef<Interrupt<InterruptType> | undefined>;
  /**
   * `true` while a run is active or being started on the current
   * thread. Driven by root-namespace lifecycle events (`running` →
   * `true`, terminal phases → `false`). Use this to disable submit
   * buttons and show in-flight spinners.
   */
  readonly isLoading: ComputedRef<boolean>;
  /**
   * `true` while the initial `thread.getState()` hydration for the
   * active thread is in flight. Distinct from {@link isLoading} —
   * thread loading covers the one-time fetch that seeds
   * {@link values} / {@link messages} before any user submit.
   */
  readonly isThreadLoading: ComputedRef<boolean>;
  /**
   * The last error observed on the active run or hydration attempt.
   * `undefined` when no error has occurred. Cleared optimistically
   * when a new {@link submit} starts.
   */
  readonly error: ComputedRef<unknown>;
  /**
   * Id of the thread the controller is bound to. `null` until the
   * first {@link submit} creates or selects a thread (or until an
   * explicit `threadId` option is provided and hydrated).
   */
  readonly threadId: ComputedRef<string | null>;
  /**
   * Promise that settles when the active thread's initial hydration
   * completes. Exposed so `async setup()` sites can
   * `await stream.hydrationPromise.value` to implement a
   * Suspense-like boundary. A fresh promise is installed on every
   * `threadId` change.
   */
  readonly hydrationPromise: ComputedRef<Promise<void>>;

  // ----- always-on discovery -----
  /**
   * Subagents discovered on the root run. For DeepAgent-typed
   * streams the key set is narrowed to the subagent names declared
   * on the agent brand (`keyof InferSubagentStates<T>`).
   */
  readonly subagents: Readonly<
    ShallowRef<
      ReadonlyMap<
        keyof SubagentStates & string extends never
          ? string
          : keyof SubagentStates & string,
        SubagentDiscoverySnapshot
      >
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
  readonly subgraphs: Readonly<
    ShallowRef<ReadonlyMap<string, SubgraphDiscoverySnapshot>>
  >;
  /**
   * Subgraphs indexed by the graph node that produced them
   * (`addNode("visualizer_0", …)`). Each value is an array because
   * parallel fan-outs and loops can spawn multiple invocations of
   * the same node; arrays preserve insertion order. Updates in
   * lock-step with {@link subgraphs}.
   */
  readonly subgraphsByNode: Readonly<
    ShallowRef<ReadonlyMap<string, readonly SubgraphDiscoverySnapshot[]>>
  >;

  // ----- imperatives -----
  /**
   * Dispatch a new run on the bound thread.
   *
   * `input` is typed as `Partial<StateType>` so IDE autocompletion
   * surfaces the state keys declared on the root composable.
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
   * ```tsx
   * // Multiple root interrupts
   * for (const intr of stream.interrupts.value) {
   *   await stream.respond(decide(intr.value), { interruptId: intr.id! });
   * }
   * ```
   *
   * @example
   * ```tsx
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
   * the projections and selector composables for UI work; use this for
   * low-level protocol access (raw subscriptions, state commands, etc.).
   */
  getThread(): ThreadStream | undefined;

  /** @internal Used by selector composables. */
  readonly [STREAM_CONTROLLER]: StreamController<
    StateType,
    InterruptType,
    ConfigurableType
  >;
}

/**
 * Erased handle useful as a parameter type for helpers and wrapper
 * components that pass a `stream` through to selector composables
 * without reading `values` directly. Mirrors the React
 * `AnyStream` alias.
 *
 * Widening the generic slots to `any` is **not** enough on its own:
 * members computed from `T` in covariant positions don't collapse to a
 * top type under `any`. `toolCalls` resolves to
 * `Readonly<ShallowRef<AssembledToolCall<…, never>[]>>` — the `never`
 * output slot is narrower than a concrete handle's `…, unknown`, so a
 * fully-typed `useStream<typeof agent>()` handle would fail to assign
 * and every `useToolCalls(stream)` call would need an `as AnyStream`
 * cast. Override `toolCalls` / `values` (keeping the `ShallowRef`
 * wrapper) with their widest forms so the erased handle is a true
 * supertype of every concrete `UseStreamReturn`.
 */
export type AnyStream = Omit<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  UseStreamReturn<any, any, any>,
  "toolCalls" | "values"
> & {
  readonly toolCalls: Readonly<ShallowRef<AssembledToolCall[]>>;
  readonly values: Readonly<ShallowRef<unknown>>;
};

/** Convenience alias for the fully-resolved stream handle type. */
export type UseStreamResult<
  T = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
> = UseStreamReturn<T, InterruptType, ConfigurableType>;

/**
 * Vue Composition API binding for the v2-native stream runtime.
 *
 * Returns a handle whose projections are Vue refs so templates
 * auto-unwrap and scripts can feed them into `computed`/`watch`.
 * Scoped views (subagents, subgraphs, any namespaced projection) are
 * surfaced via the companion selector composables (`useMessages`,
 * `useToolCalls`, `useValues`, `useMessageMetadata`,
 * `useSubmissionQueue`, `useExtension`, `useChannel`, plus media
 * composables).
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { useStream } from "@langchain/vue";
 *
 * const stream = useStream({
 *   assistantId: "agent",
 *   apiUrl: "http://localhost:2024",
 * });
 * </script>
 *
 * <template>
 *   <div v-for="msg in stream.messages.value" :key="msg.id">
 *     {{ msg.content }}
 *   </div>
 *   <button @click="stream.submit({ messages: [{ type: 'human', content: 'Hi' }] })">
 *     Send
 *   </button>
 * </template>
 * ```
 *
 * `assistantId`, `client`, and `transport` are captured at setup time.
 * To bind a new assistant/transport, remount the component. Reactive
 * inputs (`threadId`, `apiUrl`, `apiKey`) trigger in-place behaviour
 * changes on the active controller.
 */
export function useStream<
  T = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
>(
  options: UseStreamOptions<InferStateType<T>>
): UseStreamReturn<T, InterruptType, ConfigurableType> {
  type StateType = InferStateType<T>;

  interface OptionsBag {
    assistantId?: string;
    threadId?: MaybeRefOrGetter<string | null | undefined>;
    client?: Client;
    apiUrl?: MaybeRefOrGetter<string | undefined>;
    apiKey?: MaybeRefOrGetter<string | undefined>;
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

  // Inherit missing apiUrl / apiKey / client from any LangChainPlugin
  // installed on the app. Vue's `inject` returns `undefined` if the
  // key was never provided; that's fine — we only merge when the
  // caller didn't set a value.
  const pluginOptions =
    inject(LANGCHAIN_OPTIONS, undefined) ?? ({} as Record<string, unknown>);

  const hasCustomAdapter =
    asBag.transport != null && typeof asBag.transport !== "string";
  const transport = asBag.transport;

  // ─── Client construction ────────────────────────────────────────────
  //
  // Identity-stable per setup. Watches apiUrl/apiKey refs so callers
  // that flip a backend at runtime get a fresh client without a full
  // remount — the controller is swapped in lock-step below.
  const resolveApiUrl = () =>
    resolveClientApiUrl({
      apiUrl:
        toValue(asBag.apiUrl) ?? (pluginOptions as { apiUrl?: string }).apiUrl,
      transport: hasCustomAdapter ? transport : asBag.transport,
    });
  const resolveApiKey = () =>
    toValue(asBag.apiKey) ?? (pluginOptions as { apiKey?: string }).apiKey;
  const explicitClient =
    asBag.client ?? (pluginOptions as { client?: Client }).client;

  const clientRef = shallowRef<Client>(
    explicitClient ??
      (new ClientCtor({
        apiUrl: resolveApiUrl(),
        apiKey: resolveApiKey(),
        callerOptions: asBag.callerOptions,
        defaultHeaders: asBag.defaultHeaders,
      }) as unknown as Client)
  );

  // Note: we intentionally bind the controller to the *initial* client
  // instance. A dynamic client swap would require tearing the
  // controller down (in-flight subscriptions, queue, hydration), so we
  // keep the rule simple: client is captured at setup. Mirrors React
  // v1 which bakes `useMemo` on `[client, assistantId, transport]`.
  const client = clientRef.value;

  // Custom adapters may omit `assistantId`; the controller still
  // requires one so it has something to forward to `threads.stream`.
  const sentinel = "_";
  const assistantId =
    "assistantId" in options ? (options.assistantId ?? sentinel) : sentinel;

  const initialThreadId = toValue(asBag.threadId) ?? null;

  // ─── Controller construction ────────────────────────────────────────
  const controller = new StreamController<
    StateType,
    InterruptType,
    ConfigurableType
  >({
    assistantId,
    client: client as unknown as Client<StateType>,
    threadId: initialThreadId,
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

  // Deferred dispose: on the next microtask after the owning scope
  // disappears. Mirrors React's StrictMode-safe activate/deactivate
  // pattern — HMR and other scope-reuse scenarios stay clean because
  // `activate()` cancels the pending dispose if the scope survives.
  const deactivate = controller.activate();
  onScopeDispose(deactivate);

  // ─── Reactivity adapters — StreamStore → shallowRef ─────────────────
  function bindStore<S>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => S
  ): Readonly<ShallowRef<S>> {
    const ref = shallowRef<S>(getSnapshot());
    const unsubscribe = subscribe(() => {
      ref.value = getSnapshot();
    });
    onScopeDispose(unsubscribe);
    return readonly(ref) as Readonly<ShallowRef<S>>;
  }

  const rootRef = bindStore<RootSnapshot<StateType, InterruptType>>(
    controller.rootStore.subscribe,
    controller.rootStore.getSnapshot
  );
  const subagentRef = bindStore<SubagentMap>(
    controller.subagentStore.subscribe,
    controller.subagentStore.getSnapshot
  );
  const subgraphRef = bindStore<SubgraphMap>(
    controller.subgraphStore.subscribe,
    controller.subgraphStore.getSnapshot
  );
  const subgraphByNodeRef = bindStore<SubgraphByNodeMap>(
    controller.subgraphByNodeStore.subscribe,
    controller.subgraphByNodeStore.getSnapshot
  );

  // Derived refs for individual root-snapshot fields. Using computed
  // means templates that read `values.value` only retrigger when the
  // root snapshot's identity actually changes — we can't split further
  // because `StreamStore` fans the whole snapshot out on every update.
  const values = computed(() => rootRef.value.values);
  const messages = computed(() => rootRef.value.messages);
  const toolCalls = computed(
    () => rootRef.value.toolCalls as InferToolCalls<T>[]
  );
  const interrupts = computed(() =>
    filterOutHeadlessToolInterrupts(rootRef.value.interrupts)
  );
  const interrupt = computed(() => interrupts.value[0]);
  const isLoading = computed(() => rootRef.value.isLoading);
  const isThreadLoading = computed(() => rootRef.value.isThreadLoading);
  const error = computed(() => rootRef.value.error);
  const threadId = computed(() => rootRef.value.threadId);
  const hydrationPromise = computed(() => controller.hydrationPromise);

  // Expose the derived refs through a `readonly(shallowRef)` shape to
  // match the rest of the public surface. `computed` already gives us
  // read-only semantics but templates type-check more cleanly when the
  // fully-typed return claims `Readonly<ShallowRef<T>>` everywhere.
  // The cast is safe — a ComputedRef<T> is structurally a
  // Readonly<Ref<T>>.
  const asShallow = <V>(c: ComputedRef<V>): Readonly<ShallowRef<V>> =>
    c as unknown as Readonly<ShallowRef<V>>;

  // ─── threadId reactivity ────────────────────────────────────────────
  //
  // Re-hydrate whenever the caller's threadId input changes post-setup.
  // The initial hydrate already fired synchronously in the controller
  // constructor, so we skip that first tick; otherwise we'd double-fetch
  // `thread.state.get()`.
  let skipFirstThreadIdWatch = true;
  watch(
    () => toValue(asBag.threadId) ?? null,
    (next) => {
      if (skipFirstThreadIdWatch) {
        skipFirstThreadIdWatch = false;
        return;
      }
      void controller.hydrate(next);
    }
  );

  // ─── Headless-tool handling ─────────────────────────────────────────
  //
  // Watch root values + protocol interrupts for items targeting a
  // registered tool, invoke the handler, and resume the run with the
  // handler's return value. Dedup via an id set so StrictMode /
  // rerenders don't replay a tool call twice.
  const handledTools = new Set<string>();
  watch(
    () => toValue(asBag.threadId) ?? null,
    () => handledTools.clear()
  );
  const tools = options.tools;
  const onTool = options.onTool;
  if (tools?.length) {
    watch(
      () => [rootRef.value.values, rootRef.value.interrupts] as const,
      () => {
        scheduleCoalescedHeadlessToolFlush(handledTools, () => {
          const rootValues = rootRef.value.values;
          const rootInterrupts = rootRef.value.interrupts;
          const bag = rootValues as unknown as Record<string, unknown>;
          const protocolInterrupts = rootInterrupts as unknown as Interrupt[];
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
      },
      { immediate: true }
    );
  }

  const handle: UseStreamReturn<T, InterruptType, ConfigurableType> = {
    values: asShallow(values) as UseStreamReturn<
      T,
      InterruptType,
      ConfigurableType
    >["values"],
    messages: asShallow(messages),
    toolCalls: asShallow(toolCalls),
    interrupts: asShallow(interrupts),
    interrupt,
    isLoading,
    isThreadLoading,
    error,
    threadId,
    hydrationPromise,
    subagents: subagentRef as UseStreamReturn<
      T,
      InterruptType,
      ConfigurableType
    >["subagents"],
    subgraphs: subgraphRef,
    subgraphsByNode: subgraphByNodeRef,
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
 * Helper used by the selector composables to reach the underlying
 * {@link ChannelRegistry} from a stream handle. Kept internal —
 * application code should call `useMessages`, `useToolCalls`, etc.
 *
 * @internal
 */
export function getRegistry(stream: AnyStream): ChannelRegistry {
  return stream[STREAM_CONTROLLER].registry;
}

export type { ThreadStream };
