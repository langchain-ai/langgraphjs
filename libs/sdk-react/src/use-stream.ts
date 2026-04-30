/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { BaseMessage } from "@langchain/core/messages";
import type { Client, Interrupt } from "@langchain/langgraph-sdk";
import {
  filterOutHeadlessToolInterrupts,
  flushPendingHeadlessToolInterrupts,
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
  readonly toolCalls: AssembledToolCall[];
  readonly interrupts: Interrupt<InterruptType>[];
  readonly interrupt: Interrupt<InterruptType> | undefined;
  readonly isLoading: boolean;
  readonly isThreadLoading: boolean;
  /**
   * Promise that settles when the current thread's initial hydration
   * completes. Exposed so Suspense wrappers can `throw` it until the
   * first {@link StreamController.hydrate} call resolves (or rejects)
   * for the active thread. A fresh promise is installed on every
   * `switchThread`/`threadId` change.
   */
  readonly hydrationPromise: Promise<void>;
  readonly error: unknown;
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
   * surfaces the state keys declared on the root hook. Pass `null`
   * (or omit fields) when resuming an interrupt via `options.command.resume`
   * — the server accepts a null payload in that case.
   */
  submit(
    input: WidenUpdateMessages<Partial<StateType>> | null | undefined,
    options?: StreamSubmitOptions<StateType, ConfigurableType>
  ): Promise<void>;
  stop(): Promise<void>;
  respond(
    response: unknown,
    target?: { interruptId: string; namespace?: string[] }
  ): Promise<void>;

  // ----- identity -----
  readonly client: Client;
  readonly assistantId: string;

  /** v2 escape hatch — returns the bound {@link ThreadStream}. */
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
 * Any fully-typed `UseStreamReturn<S, I, C>` is
 * assignable to `AnyStream` because the generic slots are `any`
 * (bivariant), which avoids the `CompiledStateGraph` → `Record<string,
 * unknown>` assignment friction you hit when using the bare
 * `UseStreamReturn` default.
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStream = UseStreamReturn<any, any, any>;

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
    onCreated?: (meta: { run_id: string; thread_id: string }) => void;
    initialValues?: StateType;
    messagesKey?: string;
  }
  const asBag = options as OptionsBag;
  // Narrow once: a non-string `transport` is a custom adapter; anything
  // else (`"sse"` / `"websocket"` / `undefined`) is a built-in.
  const hasCustomAdapter =
    asBag.transport != null && typeof asBag.transport !== "string";
  const transport = asBag.transport;

  const client = useMemo<Client>(
    () =>
      asBag.client ??
      (new ClientCtor({
        apiUrl: asBag.apiUrl,
        apiKey: asBag.apiKey,
        callerOptions: asBag.callerOptions,
        defaultHeaders: asBag.defaultHeaders,
      }) as unknown as Client),
    [
      asBag.client,
      asBag.apiUrl,
      asBag.apiKey,
      asBag.callerOptions,
      asBag.defaultHeaders,
    ]
  );

  // Custom adapters may omit `assistantId`; the controller still
  // requires one so it has something to forward to `threads.stream`.
  // `"_"` is the well-known sentinel for "adapter doesn't care".
  const sentinel = "_";
  const assistantId =
    "assistantId" in options ? (options.assistantId ?? sentinel) : sentinel;

  // Recreate the controller only on assistantId / client / transport
  // change; the ThreadStream is bound to one assistant for its
  // lifetime and we want selector-hook subscriptions to stay stable
  // across renders.
  const controller = useMemo(
    () =>
      new StreamController<StateType, InterruptType, ConfigurableType>({
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
        initialValues: options.initialValues,
        messagesKey: options.messagesKey,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, assistantId, transport]
  );

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
  // re-render. We feed both sources to the flush helper because
  // v2-native runs surface protocol interrupts via
  // `rootStore.interrupts` (`input.requested` events), while legacy
  // graphs may still emit `values.__interrupt__`.
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
    const existingInterrupts = Array.isArray(valuesBag?.__interrupt__)
      ? (valuesBag.__interrupt__ as Interrupt[])
      : [];
    const combined: Interrupt[] = [
      ...existingInterrupts,
      ...(rootInterruptsForTools as unknown as Interrupt[]),
    ];
    if (combined.length === 0) return;
    flushPendingHeadlessToolInterrupts(
      { ...valuesBag, __interrupt__: combined },
      tools,
      handledToolsRef.current,
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
      toolCalls: root.toolCalls,
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
      stop: () => controller.stop(),
      respond: (response, target) => controller.respond(response, target),
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
export function getRegistry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stream: UseStreamReturn<any, any, any>
): ChannelRegistry {
  return stream[STREAM_CONTROLLER].registry;
}

export type { ThreadStream };
