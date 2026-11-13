/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import {
  Client,
  type AnyHeadlessToolImplementation,
  type Interrupt,
  type Message,
} from "@langchain/langgraph-sdk";
import {
  StreamOrchestrator,
  SubgraphDiscovery,
  ensureMessageInstances,
  seedToolCallsFromMessages,
  type AcceptBaseMessages,
  type AssembledToolCall,
  type InferAssembledToolCalls,
  type InferStateType,
  type SubagentStreamInterface,
  type SubgraphByNodeMap,
  type SubgraphMap,
} from "@langchain/langgraph-sdk/ui";
import type {
  StreamRespondAllOptions,
  StreamRespondOptions,
  StreamStopOptions,
  StreamSubmitOptions,
  SubagentDiscoverySnapshot,
  UseStreamOptions,
} from "./types.js";

/**
 * Key of the stream engine on a `useStream` result, which the selector hooks
 * read. Use the hooks and the stream's functions instead.
 */
export const STREAM_CONTROLLER: unique symbol = Symbol.for(
  "@langchain/react/controller"
);

/** @deprecated Read `interrupts` and answer with `respond`. */
export interface StreamThread {
  readonly interrupts: ReadonlyArray<{
    interruptId: string;
    namespace: string[];
    payload: unknown;
  }>;
  /** Calls `listener` with each error of the stream's runs and reads. */
  onError(listener: (error: Error) => void): () => void;
}

export interface UseStreamReturn<
  T = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
  StateType extends object = InferStateType<T>,
> {
  /**
   * The thread's state: the running run's latest values, or the state last
   * read. The messages key holds {@link messages}.
   */
  readonly values: StateType;
  /** @internal Type-only: the state shape, for helper types. */
  readonly "~stateType"?: StateType;
  /** The main conversation's messages, streamed token by token. */
  readonly messages: BaseMessage[];
  /** The tool calls of {@link messages}, with their results. */
  readonly toolCalls: InferAssembledToolCalls<T>[];
  /** Interrupts waiting for an answer, nested ones with their `namespace`. */
  readonly interrupts: Interrupt<InterruptType>[];
  /** The first of {@link interrupts}. */
  readonly interrupt: Interrupt<InterruptType> | undefined;
  /** Whether a run is streaming. */
  readonly isLoading: boolean;
  /** Whether the thread's state is being read for the first time. */
  readonly isThreadLoading: boolean;
  /** Settles once the latest thread load is done. It never rejects. */
  readonly hydrationPromise: Promise<void>;
  /** The last run's or thread read's error, until the next run starts or read succeeds. */
  readonly error: unknown;
  /** The thread shown, or `null` until a submit creates one. */
  readonly threadId: string | null;
  /** Subagents the runs started, by the id of their `task` tool call. */
  readonly subagents: ReadonlyMap<string, SubagentDiscoverySnapshot>;
  /** Subgraphs the runs entered, by namespace. */
  readonly subgraphs: SubgraphMap;
  /** {@link subgraphs} by the graph node that started them. */
  readonly subgraphsByNode: SubgraphByNodeMap;

  /** Start a run on the thread, creating the thread first if there is none. */
  submit(
    input: AcceptBaseMessages<Partial<StateType>> | null | undefined,
    options?: StreamSubmitOptions<StateType, ConfigurableType>
  ): Promise<void>;
  /** Stop the run being streamed, and cancel it on the server unless `cancel` is `false`. */
  stop(options?: StreamStopOptions): Promise<void>;
  /** Stop streaming the run here and leave it running: `stop({ cancel: false })`. */
  disconnect(): Promise<void>;
  /**
   * Answer an interrupt: `options.interruptId`, or the one {@link interrupt}
   * shows. During a run the answer waits in the queue behind it.
   */
  respond(
    response: unknown,
    options?: StreamRespondOptions<ConfigurableType>
  ): Promise<void>;
  /** Answer several interrupts, by id, in one run. */
  respondAll(
    responsesById: Record<string, unknown>,
    options?: StreamRespondAllOptions<ConfigurableType>
  ): Promise<void>;
  /**
   * Load a thread, or read the current one again, and join its running run.
   * Resolves once the load is done.
   */
  hydrate(threadId?: string | null): Promise<void>;

  /** The client every request goes through. */
  readonly client: Client;
  /** The assistant runs start with. */
  readonly assistantId: string;

  /** @deprecated Read {@link interrupts} and answer with {@link respond}. */
  getThread(): StreamThread | undefined;

  /** @internal Read by the selector hooks. */
  readonly [STREAM_CONTROLLER]: StreamOrchestrator;
}

export type UseStreamResult<
  T = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
> = UseStreamReturn<T, InterruptType, ConfigurableType>;

/**
 * Any stream, for helpers that pass one to the selector hooks. The members
 * typed from the state are widened, so every `useStream` result fits without
 * a cast.
 */
export type AnyStream = Omit<
  UseStreamReturn<any, any, any>,
  "toolCalls" | "values" | "~stateType"
> & {
  readonly toolCalls: AssembledToolCall[];
  readonly values: unknown;
  readonly "~stateType"?: unknown;
};

/** The tool calls of some messages, and the messages they came from. */
export interface ToolCalls {
  readonly sources: BaseMessage[];
  readonly toolCalls: AssembledToolCall[];
}

function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/**
 * Tool calls are rebuilt only when a message with tool calls or results
 * changes, so they keep their identity while text streams.
 */
export function toolCallsOf(
  messages: BaseMessage[],
  namespace: readonly string[],
  previous?: ToolCalls
): ToolCalls {
  const sources = messages.filter(
    (message) =>
      message.getType() === "tool" ||
      ((message as AIMessage).tool_calls?.length ?? 0) > 0
  );
  if (previous != null && sameItems(previous.sources, sources)) {
    return previous;
  }
  return {
    sources,
    toolCalls: seedToolCallsFromMessages(namespace, sources),
  };
}

/** @internal What a `useStream` call keeps between renders. */
export interface StreamBinding {
  /** The options the client and engine were built from. */
  deps: readonly unknown[];
  /** The latest render's options, which the engine's callbacks read. */
  readonly latest: { current: UseStreamOptions };
  readonly client: Client;
  readonly assistantId: string;
  readonly engine: StreamOrchestrator;
  /** Kept current by the hook, since the engine reads it on each interrupt. */
  readonly tools: AnyHeadlessToolImplementation[];
  readonly queue: "local" | "server";
  /** Whether a render that used it committed. */
  committed: boolean;
  /** Read the thread, once: at the first client snapshot or effect. */
  start(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): UseStreamReturn;
  /** What a server render, and the hydration of its HTML, show: the thread loading. */
  getServerSnapshot(): UseStreamReturn;
}

const bindings = new WeakMap<StreamOrchestrator, StreamBinding>();

/** @internal The hook state of a stream's engine. */
export function bindingOf(engine: StreamOrchestrator): StreamBinding {
  return bindings.get(engine)!;
}

/**
 * @internal Bindings of first renders that suspended, by thread, for their
 * retry: React drops a suspended first render's refs, and a new engine would
 * read the thread again.
 */
export const suspendedBindings = new Map<string, StreamBinding>();

const NO_INTERRUPTS: Interrupt[] = [];

let warnedClientAndFetch = false;

function messagesKeyOf(options: UseStreamOptions): string {
  return options.messagesKey ?? "messages";
}

function depsOf(options: UseStreamOptions): unknown[] {
  return [
    options.client,
    options.apiUrl,
    options.apiKey,
    options.fetch != null,
    options.assistantId,
    // By entry, so an inline object keeps the client while its values do.
    ...entriesOf(options.callerOptions),
    ...entriesOf(options.defaultHeaders),
  ];
}

/** Its entries after their count, so two objects' entries can't run together. */
function entriesOf(value: object | undefined): unknown[] {
  return value == null
    ? [value]
    : [Object.keys(value).length, ...Object.entries(value).flat()];
}

function createBinding(
  options: UseStreamOptions,
  deps: readonly unknown[]
): StreamBinding {
  const latest = { current: options };
  const { assistantId } = options;
  if (
    options.client != null &&
    options.fetch != null &&
    !warnedClientAndFetch
  ) {
    warnedClientAndFetch = true;
    console.warn(
      "@langchain/react: `fetch` is ignored when `client` is passed. Set it on the client instead."
    );
  }
  const client =
    options.client ??
    new Client({
      apiUrl: options.apiUrl,
      apiKey: options.apiKey,
      defaultHeaders: options.defaultHeaders,
      callerOptions:
        options.fetch == null
          ? options.callerOptions
          : {
              ...options.callerOptions,
              // Calls the latest one, so an inline `fetch` doesn't rebuild
              // the client on every render.
              fetch: (...args: Parameters<typeof fetch>) =>
                (latest.current.fetch ?? fetch)(...args),
            },
    });
  const tools = [...(options.tools ?? [])];
  const errorListeners = new Set<(error: Error) => void>();
  const engine = new StreamOrchestrator(
    {
      assistantId,
      initialValues: options.initialValues,
      messagesKey: options.messagesKey,
      optimistic: options.optimistic,
      queue: options.queue,
      maxReconnectAttempts: options.maxReconnectAttempts,
      reconnectDelayMs: options.reconnectDelayMs,
      streamIdleReconnect: options.streamIdleReconnect,
      onReconnect: (info) => latest.current.onReconnect?.(info),
      onConnected: (info) => latest.current.onConnected?.(info),
      onThreadId: (threadId) => latest.current.onThreadId?.(threadId),
      onCreated: (run) => latest.current.onCreated?.({ runId: run.run_id }),
      onRunEnd: (run) => latest.current.onCompleted?.(run),
      onError: (error) => {
        const asError =
          // eslint-disable-next-line no-instanceof/no-instanceof
          error instanceof Error ? error : new Error(String(error));
        for (const listener of errorListeners) listener(asError);
      },
      tools,
      onTool: (event) => latest.current.onTool?.(event),
      scopedSubagents: true,
      subagentToolNames: ["task"],
      throttle: true,
    },
    {
      getClient: () => client,
      getAssistantId: () => assistantId,
      getMessagesKey: () => messagesKeyOf(latest.current),
    }
  );
  engine.trackStreamMode("messages-tuple", "custom");

  const discovery = new SubgraphDiscovery();
  let discoveryThread = engine.threadId;
  engine.onChannelEvent((event) => discovery.push(event));
  engine.subscribe(() => {
    if (engine.threadId === discoveryThread) return;
    discoveryThread = engine.threadId;
    discovery.reset();
  });

  const actions = {
    async submit(
      input: unknown,
      submitOptions: StreamSubmitOptions = {}
    ): Promise<void> {
      const { forkFrom, threadId, ...rest } = submitOptions;
      // Thrown here because the engine would send it, and the server's
      // refusal would reach only `onError`, where 1.x apps don't look.
      if (rest.multitaskStrategy === "reject" && engine.isLoading) {
        throw new Error(
          "submit() rejected: a run is already in flight and multitaskStrategy is 'reject'."
        );
      }
      if (
        threadId !== undefined &&
        (threadId ?? undefined) !== engine.threadId
      ) {
        await engine.hydrate(threadId);
      }
      await engine.submit(input as Record<string, unknown>, {
        ...rest,
        checkpoint:
          forkFrom == null
            ? undefined
            : {
                checkpoint_id: forkFrom,
                checkpoint_ns: "",
                checkpoint_map: null,
              },
      });
    },
    stop: (stopOptions?: StreamStopOptions) => engine.stop(stopOptions),
    disconnect: () => engine.stop({ cancel: false }),
    respond: (response: unknown, respondOptions?: StreamRespondOptions) =>
      engine.respond(response, respondOptions),
    respondAll: (
      responses: Record<string, unknown>,
      respondOptions?: StreamRespondAllOptions
    ) => engine.respondAll(responses, respondOptions),
    hydrate: (threadId?: string | null) => engine.hydrate(threadId),
    getThread: (): StreamThread | undefined =>
      engine.threadId == null
        ? undefined
        : {
            interrupts: engine.interrupts.flatMap(({ id, value, namespace }) =>
              id == null
                ? []
                : [
                    {
                      interruptId: id,
                      namespace: namespace ?? [],
                      payload: value,
                    },
                  ]
            ),
            onError(listener) {
              errorListeners.add(listener);
              return () => {
                errorListeners.delete(listener);
              };
            },
          },
  };

  const instances = new WeakMap<object, BaseMessage>();
  const toInstance = (message: Message | BaseMessage): BaseMessage => {
    if (typeof (message as BaseMessage).getType === "function") {
      return message as BaseMessage;
    }
    let instance = instances.get(message);
    if (instance == null) {
      [instance] = ensureMessageInstances([message]) as BaseMessage[];
      instances.set(message, instance);
    }
    return instance;
  };

  let started = false;
  let parts: unknown[] = [];
  let snapshot: UseStreamReturn | undefined;
  let serverSnapshot: UseStreamReturn | undefined;
  let shownValues: unknown;
  let toolCalls: ToolCalls | undefined;
  let subagents: ReadonlyMap<string, SubagentDiscoverySnapshot> = new Map();

  const build = (): UseStreamReturn => {
    const next = [
      engine.getSnapshot(),
      discovery.snapshot,
      discovery.byNodeSnapshot,
    ];
    if (snapshot != null && next.every((part, i) => part === parts[i])) {
      return snapshot;
    }
    parts = next;
    const previous = snapshot;
    const instances = engine.messages.map(toInstance);
    // Kept while unchanged, so a flip of `isLoading` alone leaves `values`
    // and `messages` as they were.
    const messages =
      previous != null && sameItems(previous.messages, instances)
        ? previous.messages
        : instances;
    const values = engine.values;
    const messagesKey = messagesKeyOf(latest.current);
    toolCalls = toolCallsOf(messages, [], toolCalls);
    subagents = subagentsOf(engine.subagents, subagents);
    // Only ones `respond()` can answer: the engine's
    // `{ when: "breakpoint" }` placeholder has no id.
    const shown = engine.interrupts.filter((interrupt) => interrupt.id != null);
    const interrupts =
      shown.length === 0
        ? NO_INTERRUPTS
        : shown.map((interrupt) =>
            interrupt.namespace == null
              ? { ...interrupt, namespace: [] }
              : interrupt
          );
    snapshot = {
      values: !Array.isArray(values[messagesKey])
        ? values
        : values === shownValues && previous?.values[messagesKey] === messages
          ? previous.values
          : { ...values, [messagesKey]: messages },
      messages,
      toolCalls: toolCalls.toolCalls,
      interrupts,
      interrupt: interrupts[0],
      isLoading: engine.isLoading,
      isThreadLoading: engine.isThreadLoading,
      hydrationPromise: engine.hydrationPromise,
      error: engine.error,
      threadId: engine.threadId ?? null,
      subagents,
      subgraphs: discovery.snapshot,
      subgraphsByNode: discovery.byNodeSnapshot,
      ...actions,
      client,
      assistantId,
      [STREAM_CONTROLLER]: engine,
    } as UseStreamReturn;
    shownValues = values;
    return snapshot;
  };

  const binding: StreamBinding = {
    deps,
    latest,
    client,
    assistantId,
    engine,
    tools,
    queue: options.queue ?? "server",
    committed: false,
    subscribe(listener) {
      const unsubscribe = [
        engine.subscribe(listener),
        discovery.store.subscribe(listener),
        discovery.byNodeStore.subscribe(listener),
      ];
      return () => unsubscribe.forEach((off) => off());
    },
    start() {
      if (started) return;
      started = true;
      engine.initThreadId(options.threadId ?? undefined);
    },
    getSnapshot() {
      // During the first client render, so a Suspense boundary has a load to
      // wait for. A server render takes the server snapshot and reads
      // nothing: the user's auth is in the browser.
      binding.start();
      return build();
    },
    getServerSnapshot() {
      const threadId = options.threadId ?? null;
      serverSnapshot ??= {
        ...build(),
        threadId,
        isThreadLoading: threadId != null,
      };
      return serverSnapshot;
    },
  };
  bindings.set(engine, binding);
  return binding;
}

function subagentsOf(
  current: Map<string, SubagentStreamInterface>,
  previous: ReadonlyMap<string, SubagentDiscoverySnapshot>
): ReadonlyMap<string, SubagentDiscoverySnapshot> {
  let changed = current.size !== previous.size;
  const next = new Map<string, SubagentDiscoverySnapshot>();
  for (const [id, subagent] of current) {
    const before = previous.get(id);
    const snapshot = toSubagentSnapshot(subagent, before);
    changed ||= snapshot !== before;
    next.set(id, snapshot);
  }
  return changed ? next : previous;
}

function toSubagentSnapshot(
  subagent: SubagentStreamInterface,
  previous: SubagentDiscoverySnapshot | undefined
): SubagentDiscoverySnapshot {
  const { subagent_type: name, description } = subagent.toolCall.args;
  const next: SubagentDiscoverySnapshot = {
    id: subagent.id,
    name: name ?? "",
    // Until its namespace is known, the selector hooks look it up by this.
    namespace:
      subagent.namespace.length > 0
        ? subagent.namespace
        : [`tools:${subagent.id}`],
    parentId: subagent.parentId,
    depth: subagent.depth,
    status: subagent.status === "pending" ? "running" : subagent.status,
    taskInput: description,
    output: subagent.result ?? undefined,
    error: subagent.error == null ? undefined : String(subagent.error),
    startedAt: subagent.startedAt ?? previous?.startedAt ?? new Date(),
    completedAt: subagent.completedAt,
  };
  const same =
    previous != null &&
    (Object.keys(next) as (keyof SubagentDiscoverySnapshot)[]).every((key) =>
      key === "namespace"
        ? previous.namespace.join("|") === next.namespace.join("|")
        : previous[key] === next[key]
    );
  return same ? previous : next;
}

/**
 * @internal `useStream`'s state and its binding. With a `suspenseKey`, a
 * first render takes the binding a suspended render of that key kept.
 */
export function useStreamBinding(
  options: UseStreamOptions,
  suspenseKey?: string
): { binding: StreamBinding; stream: UseStreamReturn } {
  const ref = useRef<StreamBinding>(null);
  const deps = depsOf(options);
  if (
    ref.current == null ||
    deps.some((dep, i) => dep !== ref.current!.deps[i])
  ) {
    const kept =
      ref.current == null && suspenseKey != null
        ? suspendedBindings.get(suspenseKey)
        : undefined;
    if (kept != null && kept.deps[0] === options.client) {
      suspendedBindings.delete(suspenseKey!);
      kept.deps = deps;
      ref.current = kept;
    } else {
      ref.current = createBinding(options, deps);
    }
  }
  const binding = ref.current;
  binding.latest.current = options;
  const { engine, tools } = binding;

  useEffect(() => {
    binding.committed = true;
    return engine.activate();
  }, [binding, engine]);

  useEffect(() => {
    // After hydration this effect comes before the first client snapshot.
    binding.start();
    const threadId = options.threadId ?? null;
    if (threadId !== (engine.threadId ?? null)) void engine.hydrate(threadId);
  }, [binding, engine, options.threadId]);

  useEffect(() => {
    tools.splice(0, tools.length, ...(options.tools ?? []));
  }, [tools, options.tools]);

  const stream = useSyncExternalStore(
    binding.subscribe,
    binding.getSnapshot,
    binding.getServerSnapshot
  );

  // A loaded thread's subagents come from its messages' `task` calls. The
  // engine skips this while a run streams them.
  useEffect(() => {
    engine.reconstructSubagentsIfNeeded();
  }, [
    engine,
    stream.isLoading,
    stream.isThreadLoading,
    stream.messages.length,
  ]);

  return { binding, stream };
}

/**
 * React binding for the stream engine of `@langchain/langgraph-sdk/ui`.
 *
 * Gives the thread's `values`, `messages` and `toolCalls`, its interrupts,
 * and the subagents and subgraphs its runs start. Read a subagent's or a
 * subgraph's own messages with the selector hooks:
 *
 * ```tsx
 * function Chat() {
 *   const stream = useStream({ assistantId: "deep-agent", apiUrl });
 *   return [...stream.subagents.values()].map((subagent) => (
 *     <SubagentCard key={subagent.id} stream={stream} subagent={subagent} />
 *   ));
 * }
 *
 * function SubagentCard({ stream, subagent }) {
 *   const messages = useMessages(stream, subagent);
 *   return <Feed messages={messages} />;
 * }
 * ```
 *
 * The first type parameter takes a state type or a compiled graph or agent
 * (`useStream<typeof agent>()`), whose state it infers.
 */
export function useStream<
  T = Record<string, unknown>,
  InterruptType = unknown,
  ConfigurableType extends object = Record<string, unknown>,
>(
  options: UseStreamOptions<InferStateType<T>>
): UseStreamReturn<T, InterruptType, ConfigurableType> {
  return useStreamBinding(options as UseStreamOptions)
    .stream as unknown as UseStreamReturn<T, InterruptType, ConfigurableType>;
}
