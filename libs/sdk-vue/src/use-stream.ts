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
  filterOutHeadlessToolInterrupts,
  flushPendingHeadlessToolInterrupts,
  type AnyHeadlessToolImplementation,
  type OnToolCallback,
} from "@langchain/langgraph-sdk";
import {
  Client as ClientCtor,
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
  type RootSnapshot,
  type StateOf as StreamStateOf,
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

/** @deprecated Prefer {@link InferStateType}. */
export type StateOf<T> = StreamStateOf<T>;

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
  readonly values: Readonly<ShallowRef<StateType>>;
  readonly messages: Readonly<ShallowRef<BaseMessage[]>>;
  readonly toolCalls: Readonly<ShallowRef<AssembledToolCall[]>>;
  readonly interrupts: Readonly<ShallowRef<Interrupt<InterruptType>[]>>;
  readonly interrupt: ComputedRef<Interrupt<InterruptType> | undefined>;
  readonly isLoading: ComputedRef<boolean>;
  readonly isThreadLoading: ComputedRef<boolean>;
  readonly error: ComputedRef<unknown>;
  readonly threadId: ComputedRef<string | null>;

  /**
   * Promise that settles when the active thread's initial hydration
   * completes. Exposed so `async setup()` sites can
   * `await stream.hydrationPromise` to implement a Suspense-like
   * boundary.
   */
  readonly hydrationPromise: ComputedRef<Promise<void>>;

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
  readonly subgraphs: Readonly<
    ShallowRef<ReadonlyMap<string, SubgraphDiscoverySnapshot>>
  >;
  readonly subgraphsByNode: Readonly<
    ShallowRef<ReadonlyMap<string, readonly SubgraphDiscoverySnapshot[]>>
  >;

  submit(
    input: WidenUpdateMessages<Partial<StateType>> | null | undefined,
    options?: StreamSubmitOptions<StateType, ConfigurableType>
  ): Promise<void>;
  stop(): Promise<void>;
  respond(
    response: unknown,
    target?: { interruptId: string; namespace?: string[] }
  ): Promise<void>;

  readonly client: Client;
  readonly assistantId: string;

  /** v2 escape hatch — returns the bound {@link ThreadStream}. */
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
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStream = UseStreamReturn<any, any, any>;

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
    onCreated?: (meta: { run_id: string; thread_id: string }) => void;
    initialValues?: StateType;
    messagesKey?: string;
    tools?: AnyHeadlessToolImplementation[];
    onTool?: OnToolCallback;
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
    toValue(asBag.apiUrl) ?? (pluginOptions as { apiUrl?: string }).apiUrl;
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
    initialValues: options.initialValues,
    messagesKey: options.messagesKey,
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
  const toolCalls = computed(() => rootRef.value.toolCalls);
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
      ([rootValues, rootInterrupts]) => {
        const bag = rootValues as unknown as Record<string, unknown>;
        const existing = Array.isArray(bag?.__interrupt__)
          ? (bag.__interrupt__ as Interrupt[])
          : [];
        const combined: Interrupt[] = [
          ...existing,
          ...(rootInterrupts as unknown as Interrupt[]),
        ];
        if (combined.length === 0) return;
        flushPendingHeadlessToolInterrupts(
          { ...bag, __interrupt__: combined },
          tools,
          handledTools,
          {
            onTool,
            defer: (run) => {
              void Promise.resolve().then(run);
            },
            resumeSubmit: (command) =>
              controller.submit(null, {
                command,
              } as StreamSubmitOptions<StateType, ConfigurableType>),
          }
        );
      },
      { immediate: true, flush: "sync" }
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
    stop: () => controller.stop(),
    respond: (response, target) => controller.respond(response, target),
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
export function getRegistry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stream: UseStreamReturn<any, any, any>
): ChannelRegistry {
  return stream[STREAM_CONTROLLER].registry;
}

export type { ThreadStream };
