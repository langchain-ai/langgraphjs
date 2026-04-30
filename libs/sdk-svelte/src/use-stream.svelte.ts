import { onDestroy } from "svelte";
import type { BaseMessage } from "@langchain/core/messages";
import type { Client, Interrupt } from "@langchain/langgraph-sdk";
import {
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
  readonly values: StateType;
  readonly messages: BaseMessage[];
  readonly toolCalls: AssembledToolCall[];
  readonly interrupts: Interrupt<InterruptType>[];
  readonly interrupt: Interrupt<InterruptType> | undefined;
  readonly isLoading: boolean;
  readonly isThreadLoading: boolean;
  readonly error: unknown;
  readonly threadId: string | null;
  /**
   * Promise that settles when the current thread's initial hydration
   * completes. Useful in SvelteKit `load()` handlers (or any
   * async-init site) to block until the controller has reconciled
   * with server-held state.
   */
  readonly hydrationPromise: Promise<void>;

  readonly subagents: ReadonlyMap<
    keyof SubagentStates & string extends never
      ? string
      : keyof SubagentStates & string,
    SubagentDiscoverySnapshot
  >;
  readonly subgraphs: ReadonlyMap<string, SubgraphDiscoverySnapshot>;
  readonly subgraphsByNode: ReadonlyMap<
    string,
    readonly SubgraphDiscoverySnapshot[]
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

  // Client construction — captured once at init. Consumers that need
  // to swap `apiUrl`/`apiKey` at runtime remount the owning component.
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
    initialValues: options.initialValues,
    messagesKey: options.messagesKey,
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

      const valuesBag = rootSnapshot.values as unknown as Record<
        string,
        unknown
      >;
      const existing = Array.isArray(valuesBag?.__interrupt__)
        ? (valuesBag.__interrupt__ as Interrupt[])
        : [];
      const combined: Interrupt[] = [
        ...existing,
        ...(rootSnapshot.interrupts as unknown as Interrupt[]),
      ];
      if (combined.length === 0) return;
      flushPendingHeadlessToolInterrupts(
        { ...valuesBag, __interrupt__: combined },
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
      return rootSnapshot.toolCalls;
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
    stop: () => controller.stop(),
    respond: (response, target) => controller.respond(response, target),
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
export function getRegistry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stream: UseStreamReturn<any, any, any>
): ChannelRegistry {
  return stream[STREAM_CONTROLLER].registry;
}

export type { ThreadStream };
