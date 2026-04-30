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

/** @deprecated Prefer {@link InferStateType}. */
export type StateOf<T> = StreamStateOf<T>;

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
  readonly values: Signal<StateType>;
  readonly messages: Signal<BaseMessage[]>;
  readonly toolCalls: Signal<AssembledToolCall[]>;
  readonly interrupts: Signal<Interrupt<InterruptType>[]>;
  readonly interrupt: Signal<Interrupt<InterruptType> | undefined>;
  readonly isLoading: Signal<boolean>;
  readonly isThreadLoading: Signal<boolean>;
  readonly error: Signal<unknown>;
  readonly threadId: Signal<string | null>;

  /**
   * Promise that settles when the active thread's initial hydration
   * completes. Exposed so SSR/render-before-flush pipelines can
   * `await stream.hydrationPromise` before serialising.
   */
  readonly hydrationPromise: Signal<Promise<void>>;

  readonly subagents: Signal<
    ReadonlyMap<
      keyof SubagentStates & string extends never
        ? string
        : keyof SubagentStates & string,
      SubagentDiscoverySnapshot
    >
  >;
  readonly subgraphs: Signal<ReadonlyMap<string, SubgraphDiscoverySnapshot>>;
  readonly subgraphsByNode: Signal<
    ReadonlyMap<string, readonly SubgraphDiscoverySnapshot[]>
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
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStream = UseStreamReturn<any, any, any>;

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
    onCreated?: (meta: { run_id: string; thread_id: string }) => void;
    initialValues?: StateType;
    messagesKey?: string;
    tools?: AnyHeadlessToolImplementation[];
    onTool?: OnToolCallback;
  }
  const asBag = options as OptionsBag;

  const hasCustomAdapter =
    asBag.transport != null && typeof asBag.transport !== "string";
  const transport = asBag.transport;

  const client: Client =
    asBag.client ??
    (new ClientCtor({
      apiUrl: asBag.apiUrl,
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
    initialValues: options.initialValues,
    messagesKey: options.messagesKey,
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
  const toolCalls = computed(() => rootSignal().toolCalls);
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
      const snapshot = rootSignal();
      const bag = snapshot.values as unknown as Record<string, unknown>;
      const existing = Array.isArray(bag?.__interrupt__)
        ? (bag.__interrupt__ as Interrupt[])
        : [];
      const combined: Interrupt[] = [
        ...existing,
        ...(snapshot.interrupts as unknown as Interrupt[]),
      ];
      if (combined.length === 0) return;
      untracked(() => {
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
 * Helper used by the selector primitives to reach the underlying
 * {@link ChannelRegistry} from a stream handle. Kept internal —
 * application code should call `injectMessages`, `injectToolCalls`,
 * etc. instead of reading this directly.
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
