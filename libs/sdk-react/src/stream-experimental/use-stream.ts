/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { BaseMessage } from "@langchain/core/messages";
import type { Client, Interrupt } from "@langchain/langgraph-sdk";
import {
  Client as ClientCtor,
  type ClientConfig,
  type ThreadStream,
} from "@langchain/langgraph-sdk/client";
import {
  StreamController,
  type AssembledToolCall,
  type ChannelRegistry,
  type RootSnapshot,
  type StreamSubmitOptions,
  type SubagentDiscoverySnapshot,
  type SubagentMap,
  type SubgraphByNodeMap,
  type SubgraphDiscoverySnapshot,
  type SubgraphMap,
} from "@langchain/langgraph-sdk/stream";

/**
 * Unwraps a compiled graph type (anything carrying the
 * `~RunOutput` brand from `CompiledGraph`) into its state shape.
 * Any other `object` type is treated as the state itself, so
 * existing `useStreamExperimental<MyState>()` call sites keep
 * resolving to `MyState` without change.
 *
 * @example
 * ```ts
 * const agent = new StateGraph({ messages: MessagesValue }).compile();
 * type State = StateOf<typeof agent>; // { messages: BaseMessage[] }
 * type Plain = StateOf<{ foo: string }>; // { foo: string }
 * ```
 */
export type StateOf<T> = T extends { "~RunOutput": infer S }
  ? S extends object
    ? S
    : Record<string, unknown>
  : T extends object
    ? T
    : Record<string, unknown>;

/**
 * Options accepted by {@link useStreamExperimental}. Framework-
 * agnostic options are re-exported from
 * `@langchain/langgraph-sdk/stream`; React-specific
 * lifecycle callbacks live here.
 */
export interface UseStreamExperimentalOptions<
  StateType extends object = Record<string, unknown>,
> {
  assistantId: string;
  threadId?: string | null;
  client?: Client;
  apiUrl?: string;
  apiKey?: string;
  callerOptions?: ClientConfig["callerOptions"];
  defaultHeaders?: ClientConfig["defaultHeaders"];
  /** v2 transport. Defaults to `"sse"`. */
  transport?: "sse" | "websocket";
  /** Optional `fetch` override forwarded to the SSE transport. */
  fetch?: typeof fetch;
  /** Optional `WebSocket` factory for the WS transport. */
  webSocketFactory?: (url: string) => WebSocket;
  onThreadId?: (threadId: string) => void;
  onCreated?: (meta: { run_id: string; thread_id: string }) => void;
  initialValues?: StateType;
  /** State key holding the message array. Defaults to `"messages"`. */
  messagesKey?: string;
}

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
  "@langchain/react/stream-experimental/controller"
);

export interface UseStreamExperimentalReturn<
  StateType extends object = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
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
  readonly error: unknown;
  readonly threadId: string | null;

  // ----- always-on discovery -----
  readonly subagents: ReadonlyMap<string, SubagentDiscoverySnapshot>;
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
    input: Partial<StateType> | null | undefined,
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
 * Any fully-typed `UseStreamExperimentalReturn<S, I, C>` is
 * assignable to `AnyStream` because the generic slots are `any`
 * (bivariant), which avoids the `CompiledStateGraph` → `Record<string,
 * unknown>` assignment friction you hit when using the bare
 * `UseStreamExperimentalReturn` default.
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
export type AnyStream = UseStreamExperimentalReturn<any, any, any>;

/**
 * React binding for the experimental v2-native stream runtime.
 *
 * `useStreamExperimental` exposes three always-on projections
 * (`values` / `messages` / `toolCalls`) at the thread root plus
 * cheap discovery maps for subagents / subgraphs. Scoped views of
 * subagents, subgraphs, or any namespaced projection are surfaced via
 * the companion selector hooks:
 *
 * ```tsx
 * const stream = useStreamExperimental({ assistantId: "deep-agent" });
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
 * (`useStreamExperimental<MyState>()`) *or* a compiled graph type
 * (`useStreamExperimental<typeof agent>()`); in the latter case the
 * state shape is unwrapped from the graph via {@link StateOf}, so
 * `stream.values` is always typed as the state, never as the graph
 * class itself.
 *
 * @experimental API is unstable and may change until the v2 protocol
 * is GA on LangGraph Platform.
 */
export function useStreamExperimental<
  T extends object = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
>(
  options: UseStreamExperimentalOptions<StateOf<T>>
): UseStreamExperimentalReturn<StateOf<T>, InterruptType, ConfigurableType> {
  type StateType = StateOf<T>;
  const client = useMemo<Client>(
    () =>
      options.client ??
      (new ClientCtor({
        apiUrl: options.apiUrl,
        apiKey: options.apiKey,
        callerOptions: options.callerOptions,
        defaultHeaders: options.defaultHeaders,
      }) as unknown as Client),
    [
      options.client,
      options.apiUrl,
      options.apiKey,
      options.callerOptions,
      options.defaultHeaders,
    ]
  );

  // Recreate the controller only on assistantId / client change; the
  // ThreadStream is bound to one assistant for its lifetime and we
  // want selector-hook subscriptions to stay stable across renders.
  const controller = useMemo(
    () =>
      new StreamController<StateType, InterruptType, ConfigurableType>({
        assistantId: options.assistantId,
        // Cast: the runtime `Client` is state-shape agnostic, but the
        // controller declares `client: Client<StateType>` so its own
        // typings line up. Tightening `submit`'s `input` parameter to
        // `Partial<StateType>` surfaced this variance mismatch that
        // was previously masked — the cast is equivalent to the
        // ClientCtor cast above.
        client: client as unknown as Client<StateType>,
        threadId: options.threadId ?? null,
        transport: options.transport,
        fetch: options.fetch,
        webSocketFactory: options.webSocketFactory,
        onThreadId: options.onThreadId,
        onCreated: options.onCreated,
        initialValues: options.initialValues,
        messagesKey: options.messagesKey,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, options.assistantId]
  );

  // Rehydrate on threadId change; initial mount uses the id passed to
  // the constructor.
  useEffect(() => {
    void controller.hydrate(options.threadId ?? null);
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

  return useMemo<
    UseStreamExperimentalReturn<StateType, InterruptType, ConfigurableType>
  >(
    () => ({
      values: root.values,
      messages: root.messages,
      toolCalls: root.toolCalls,
      interrupts: root.interrupts,
      interrupt: root.interrupt,
      isLoading: root.isLoading,
      isThreadLoading: root.isThreadLoading,
      error: root.error,
      threadId: root.threadId,
      subagents,
      subgraphs,
      subgraphsByNode,
      submit: (input, submitOptions) => controller.submit(input, submitOptions),
      stop: () => controller.stop(),
      respond: (response, target) => controller.respond(response, target),
      getThread: () => controller.getThread(),
      client,
      assistantId: options.assistantId,
      [STREAM_CONTROLLER]: controller,
    }),
    [
      root,
      subagents,
      subgraphs,
      subgraphsByNode,
      controller,
      client,
      options.assistantId,
    ]
  );
}

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
  stream: UseStreamExperimentalReturn<any, any, any>
): ChannelRegistry {
  return stream[STREAM_CONTROLLER].registry;
}

export type { ThreadStream };
