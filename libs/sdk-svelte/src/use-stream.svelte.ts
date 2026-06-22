import { onDestroy } from "svelte";
import type { BaseMessage } from "@langchain/core/messages";
import type { Client, Interrupt } from "@langchain/langgraph-sdk";
import {
  applyHeadlessToolResumeCommand,
  flushPendingHeadlessToolInterrupts,
  scheduleCoalescedHeadlessToolFlush,
  type AnyHeadlessToolImplementation,
  type OnToolCallback,
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

/**
 * A value that may be either a plain `T` or a getter `() => T`. Used
 * for reactive-capable option inputs (currently `threadId` only). When
 * a getter is passed the composable tracks it via `$effect` and
 * re-hydrates when the returned value changes.
 */
export type ValueOrGetter<T> = T | (() => T);

function readValueOrGetter<T>(
  input: ValueOrGetter<T> | undefined
): T | undefined {
  if (typeof input === "function") return (input as () => T)();
  return input;
}

type SvelteThreadId = ValueOrGetter<string | null | undefined>;

export type AgentServerOptions<StateType extends object> =
  StreamAgentServerOptions<StateType, SvelteThreadId>;

export type CustomAdapterOptions<StateType extends object> =
  StreamCustomAdapterOptions<StateType, SvelteThreadId, string>;

export type UseStreamOptions<
  StateType extends object = Record<string, unknown>,
> = StreamUseStreamOptions<
  StateType,
  SvelteThreadId,
  string | undefined,
  string | undefined,
  string
>;

/**
 * Private field on the handle that carries the {@link StreamController}
 * reference. Selector composables read this to reach the shared
 * {@link ChannelRegistry}. Use the selector composables
 * (`useMessages`, `useToolCalls`, `useValues`, …) instead of reading
 * this directly.
 */
export const STREAM_CONTROLLER: unique symbol = Symbol.for(
  "@langchain/svelte/controller"
);

/**
 * Svelte binding return type for {@link useStream}. Reactive
 * projections are exposed as getters on a stable object so templates
 * can read `stream.messages` directly without a `.value` / `.current`
 * hop and `$derived` wrappers auto-track the getter read.
 *
 * Destructuring (`const { messages } = stream`) breaks reactivity —
 * this is a Svelte 5 constraint and applies to every getter-object
 * pattern. Access fields through the live `stream` handle instead.
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
   * on token-level deltas: if you render `stream.values.messages`
   * directly you'll see full turns appear at once instead of
   * streaming token-by-token. Use {@link messages} (or
   * `useMessages`) for the token-streamed view.
   *
   * Equivalent to calling `useValues(stream)`.
   */
  readonly values: StateType;
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
   * concern — the Svelte layer faithfully renders whatever the
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
  /**
   * Promise that settles when the current thread's initial hydration
   * completes. Useful in SvelteKit `load()` handlers (or any
   * async-init site) to block until the controller has reconciled
   * with server-held state. A fresh promise is installed on every
   * `threadId` change.
   */
  readonly hydrationPromise: Promise<void>;

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
   * ```svelte
   * // Multiple root interrupts
   * {#each stream.interrupts as intr (intr.id)}
   *   <button onclick={() => stream.respond(decide(intr.value), { interruptId: intr.id! })}>
   *     Resolve
   *   </button>
   * {/each}
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
 * top type under `any`. `toolCalls: InferToolCalls<any>[]` resolves to
 * `AssembledToolCall<…, never>[]` — the `never` output slot is narrower
 * than a concrete handle's `AssembledToolCall<…, unknown>[]`, so a
 * fully-typed `useStream<typeof agent>()` handle would fail to assign
 * and every `useToolCalls(stream)` call would need an `as AnyStream`
 * cast. Override `toolCalls` / `values` with their widest forms so the
 * erased handle is a true supertype of every concrete `UseStreamReturn`.
 */
export type AnyStream = Omit<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  UseStreamReturn<any, any, any>,
  "toolCalls" | "values"
> & {
  readonly toolCalls: AssembledToolCall[];
  readonly values: unknown;
};

/**
 * Svelte 5 binding for the v2-native stream runtime.
 *
 * Returns a handle whose reactive fields are plain getters on a
 * stable object — templates can read `stream.messages` directly and
 * `$derived(stream.isLoading)` auto-tracks the getter.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { useStream } from "@langchain/svelte";
 *
 *   const stream = useStream({
 *     assistantId: "agent",
 *     apiUrl: "http://localhost:2024",
 *   });
 * </script>
 *
 * {#each stream.messages as msg (msg.id)}
 *   <div>{msg.content}</div>
 * {/each}
 * <button onclick={() =>
 *   stream.submit({ messages: [{ type: "human", content: "Hi" }] })
 * }>
 *   Send
 * </button>
 * ```
 *
 * `assistantId`, `client`, and `transport` are captured at composable
 * init. To bind a new assistant/transport, remount the component.
 * Only `threadId` is treated as reactive — pass it as a getter
 * (`threadId: () => active`) to drive an in-place thread swap.
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
    threadId?: ValueOrGetter<string | null | undefined>;
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

  // Client construction — captured once at init. Consumers that need
  // to swap `apiUrl`/`apiKey` at runtime remount the owning component.
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

  const initialThreadId = readValueOrGetter(asBag.threadId) ?? null;

  // Plain `let` binding, not `$state`: the controller holds maps of
  // listeners, Promises, and the live `ThreadStream`, none of which
  // survive Svelte's deep `$state` proxy wrapping.
  const controller = new StreamController<
    StateType,
    InterruptType,
    ConfigurableType
  >({
    assistantId,
    // `Client` is state-shape agnostic at runtime; the controller
    // advertises `Client<StateType>` on its public type for ergonomics.
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

  // Deferred dispose: mirrors React's activate/dispose pattern so HMR
  // and other scope-reuse scenarios stay clean. `activate()` cancels
  // a pending dispose if the owning scope survives.
  const deactivate = controller.activate();
  onDestroy(deactivate);

  // ─── Reactive state bridges ─────────────────────────────────────────
  //
  // Each always-on `StreamStore` is wrapped in a runes `$state` slot
  // seeded from `getSnapshot()` and kept in sync via `store.subscribe`.
  // Subscriptions are torn down on component destroy.
  let rootSnapshot = $state<RootSnapshot<StateType, InterruptType>>(
    controller.rootStore.getSnapshot()
  );
  const unsubscribeRoot = controller.rootStore.subscribe(() => {
    rootSnapshot = controller.rootStore.getSnapshot();
  });
  onDestroy(unsubscribeRoot);

  let subagentSnapshot = $state<SubagentMap>(
    controller.subagentStore.getSnapshot()
  );
  const unsubscribeSubagents = controller.subagentStore.subscribe(() => {
    subagentSnapshot = controller.subagentStore.getSnapshot();
  });
  onDestroy(unsubscribeSubagents);

  let subgraphSnapshot = $state<SubgraphMap>(
    controller.subgraphStore.getSnapshot()
  );
  const unsubscribeSubgraphs = controller.subgraphStore.subscribe(() => {
    subgraphSnapshot = controller.subgraphStore.getSnapshot();
  });
  onDestroy(unsubscribeSubgraphs);

  let subgraphByNodeSnapshot = $state<SubgraphByNodeMap>(
    controller.subgraphByNodeStore.getSnapshot()
  );
  const unsubscribeSubgraphByNode = controller.subgraphByNodeStore.subscribe(
    () => {
      subgraphByNodeSnapshot = controller.subgraphByNodeStore.getSnapshot();
    }
  );
  onDestroy(unsubscribeSubgraphByNode);

  // ─── threadId reactivity ────────────────────────────────────────────
  //
  // Only matters when the caller passed a getter. The initial hydrate
  // already fired in the controller constructor, so skip the first
  // tick to avoid a redundant `thread.state.get()`.
  if (typeof asBag.threadId === "function") {
    const getThreadId = asBag.threadId;
    let previousThreadId = initialThreadId;
    $effect(() => {
      const next = (getThreadId() ?? null) as string | null;
      if (next === previousThreadId) return;
      previousThreadId = next;
      void controller.hydrate(next);
    });
  }

  // ─── Headless-tool handling ─────────────────────────────────────────
  //
  // Watch the root `values.__interrupt__` key plus the protocol-
  // surfaced interrupts for items targeting a registered tool, invoke
  // the handler, and resume the run with the handler's return value.
  // Dedup via an id set so rerenders don't replay a tool call twice.
  const tools = options.tools;
  const onTool = options.onTool;
  if (tools?.length) {
    const handledTools = new Set<string>();
    let handledForThreadId: string | null = initialThreadId;
    $effect(() => {
      // Reset dedup set when the active thread id changes — a fresh
      // thread may legitimately re-emit a tool-call id we've seen.
      const currentThreadId = rootSnapshot.threadId;
      if (currentThreadId !== handledForThreadId) {
        handledTools.clear();
        handledForThreadId = currentThreadId;
      }

      scheduleCoalescedHeadlessToolFlush(handledTools, () => {
        const valuesBag = rootSnapshot.values as unknown as Record<
          string,
          unknown
        >;
        const protocolInterrupts =
          rootSnapshot.interrupts as unknown as Interrupt[];
        const valuesInterrupts = Array.isArray(valuesBag?.__interrupt__)
          ? (valuesBag.__interrupt__ as Interrupt[])
          : [];
        const headlessInterrupts =
          protocolInterrupts.length > 0 ? protocolInterrupts : valuesInterrupts;
        if (headlessInterrupts.length === 0) return;
        flushPendingHeadlessToolInterrupts(
          { ...valuesBag, __interrupt__: headlessInterrupts },
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
  }

  // ─── Public handle ──────────────────────────────────────────────────
  //
  // Single stable object with getters. Getters read the runes
  // `$state` slots, which drives template reactivity automatically.
  const handle: UseStreamReturn<T, InterruptType, ConfigurableType> = {
    get values() {
      return rootSnapshot.values;
    },
    get messages() {
      return rootSnapshot.messages;
    },
    get toolCalls() {
      return rootSnapshot.toolCalls as InferToolCalls<T>[];
    },
    get interrupts() {
      return rootSnapshot.interrupts;
    },
    get interrupt() {
      return rootSnapshot.interrupt;
    },
    get isLoading() {
      return rootSnapshot.isLoading;
    },
    get isThreadLoading() {
      return rootSnapshot.isThreadLoading;
    },
    get error() {
      return rootSnapshot.error;
    },
    get threadId() {
      return rootSnapshot.threadId;
    },
    get hydrationPromise() {
      return controller.hydrationPromise;
    },
    get subagents() {
      return subagentSnapshot as UseStreamReturn<
        T,
        InterruptType,
        ConfigurableType
      >["subagents"];
    },
    get subgraphs() {
      return subgraphSnapshot;
    },
    get subgraphsByNode() {
      return subgraphByNodeSnapshot;
    },
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

/** Convenience alias for the fully-resolved stream handle type. */
export type UseStreamResult<
  T = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
> = UseStreamReturn<T, InterruptType, ConfigurableType>;

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
