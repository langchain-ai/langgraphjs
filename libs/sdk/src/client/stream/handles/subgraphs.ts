import type {
  Channel,
  Event,
  LifecycleCause,
  LifecycleEvent,
  MessagesEvent,
  SubscribeParams,
  ToolsEvent,
  ValuesEvent,
} from "@langchain/protocol";
import type { SubscriptionHandle } from "../index.js";
import { MultiCursorBuffer } from "../multi-cursor-buffer.js";
import { StreamingMessageAssembler } from "../messages.js";
import type { StreamingMessage, StreamingMessageHandle } from "../messages.js";
import { ToolCallAssembler } from "./tools.js";
import type { AssembledToolCall } from "./tools.js";
import { MediaAssembler } from "../media.js";
import type {
  AudioMedia,
  FileMedia,
  ImageMedia,
  VideoMedia,
} from "../media.js";
import type {
  EventForChannel,
  EventForChannels,
  SubscribeOptions,
  YieldForChannel,
  YieldForChannels,
} from "../types.js";
import type { SubagentHandle } from "./subagents.js";

/**
 * Minimal subscription surface that {@link SubgraphHandle} and
 * {@link SubagentHandle} delegate to. Typed to match the
 * `Session.subscribe` raw-channel overloads without importing the
 * full `Session` class (avoids circular dependency).
 */
export interface Subscribable {
  subscribe<TChannel extends Channel>(
    channel: TChannel,
    options?: SubscribeOptions
  ): Promise<
    SubscriptionHandle<EventForChannel<TChannel>, YieldForChannel<TChannel>>
  >;
  subscribe<const TChannels extends readonly Channel[]>(
    channels: TChannels,
    options?: SubscribeOptions
  ): Promise<
    SubscriptionHandle<EventForChannels<TChannels>, YieldForChannels<TChannels>>
  >;
  subscribe(params: SubscribeParams): Promise<SubscriptionHandle<Event>>;
}

/**
 * Discovered subgraph within a streaming session.
 *
 * Mirrors the in-process `SubgraphRunStream` pattern: each subgraph
 * has `name`, `index`, `namespace`, and lazy getters for projections
 * scoped to this subgraph's namespace.
 *
 * ```ts
 * for await (const sub of session.subgraphs) {
 *   for await (const msg of sub.messages) { ... }
 *   const state = await sub.output;
 * }
 * ```
 */
export class SubgraphHandle {
  readonly name: string;
  readonly index: number;
  readonly namespace: string[];
  /**
   * Non-empty when upstream attached a `cause` to this subgraph's
   * `lifecycle.started` event. Population is product-specific and
   * performed by stream transformers on the runtime side (e.g.
   * deepagents' `SubagentTransformer` emits
   * `{ type: "toolCall", tool_call_id }`). Generic clients should
   * treat `cause.type` as an open enum — the protocol allows future
   * variants (`send`, `edge`, ...) to be forwarded verbatim without
   * a SDK bump.
   */
  readonly cause?: LifecycleCause;
  readonly graphName?: string;
  /**
   * Raw `tool-started` event that triggered this subgraph, when
   * `cause.type === "toolCall"` and the matching event has been
   * observed on the `tools` channel.
   */
  toolStartedEvent?: ToolsEvent;
  readonly #session: Subscribable;

  #messagesIterable?: AsyncIterable<StreamingMessage>;
  #valuesProjection?: AsyncIterable<unknown> & PromiseLike<unknown>;
  #toolCallsIterable?: AsyncIterable<AssembledToolCall>;
  #subgraphsIterable?: AsyncIterable<SubgraphHandle>;
  #subagentsIterable?: AsyncIterable<SubagentHandle>;
  #outputPromise?: Promise<unknown>;

  #mediaDispatcherStarted = false;
  #audioBuffer?: MultiCursorBuffer<AudioMedia>;
  #imagesBuffer?: MultiCursorBuffer<ImageMedia>;
  #videoBuffer?: MultiCursorBuffer<VideoMedia>;
  #filesBuffer?: MultiCursorBuffer<FileMedia>;

  constructor(
    name: string,
    index: number,
    namespace: string[],
    session: Subscribable,
    options?: {
      cause?: LifecycleCause;
      graphName?: string;
      toolStartedEvent?: ToolsEvent;
    }
  ) {
    this.name = name;
    this.index = index;
    this.namespace = namespace;
    this.cause = options?.cause;
    this.graphName = options?.graphName;
    this.toolStartedEvent = options?.toolStartedEvent;
    this.#session = session;
  }

  get messages(): AsyncIterable<StreamingMessageHandle> {
    if (this.#messagesIterable) return this.#messagesIterable;
    const buffer = new MultiCursorBuffer<StreamingMessage>();
    this.#messagesIterable = buffer;
    const assembler = new StreamingMessageAssembler();
    void this.#startProjection(
      ["messages"],
      (event) => {
        if (event.method !== "messages") return;
        const msg = assembler.consume(event as MessagesEvent);
        if (msg) buffer.push(msg);
      },
      () => buffer.close()
    );
    return buffer;
  }

  get values(): AsyncIterable<unknown> & PromiseLike<unknown> {
    if (this.#valuesProjection) return this.#valuesProjection;
    const buffer = new MultiCursorBuffer<unknown>();
    let lastValue: unknown;
    let resolveOutput!: (value: unknown) => void;
    const outputPromise = new Promise<unknown>((resolve) => {
      resolveOutput = resolve;
    });
    this.#outputPromise = outputPromise;
    const projection = Object.assign(buffer, {
      then: <TResult1 = unknown, TResult2 = never>(
        onfulfilled?:
          | ((value: unknown) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?:
          | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
          | null
      ): Promise<TResult1 | TResult2> =>
        outputPromise.then(onfulfilled, onrejected),
    }) as AsyncIterable<unknown> & PromiseLike<unknown>;
    this.#valuesProjection = projection;
    void this.#startProjection(
      ["values"],
      (event) => {
        if (event.method !== "values") return;
        const data = (event as ValuesEvent).params.data;
        lastValue = data;
        buffer.push(data);
      },
      () => {
        resolveOutput(lastValue);
        buffer.close();
      }
    );
    return projection;
  }

  get toolCalls(): AsyncIterable<AssembledToolCall> {
    if (this.#toolCallsIterable) return this.#toolCallsIterable;
    const buffer = new MultiCursorBuffer<AssembledToolCall>();
    this.#toolCallsIterable = buffer;
    const assembler = new ToolCallAssembler();
    void this.#startProjection(
      ["tools"],
      (event) => {
        if (event.method !== "tools") return;
        const tc = assembler.consume(event as ToolsEvent);
        if (tc) buffer.push(tc);
      },
      () => buffer.close()
    );
    return buffer;
  }

  get subgraphs(): AsyncIterable<SubgraphHandle> {
    if (this.#subgraphsIterable) return this.#subgraphsIterable;
    const buffer = new MultiCursorBuffer<SubgraphHandle>();
    this.#subgraphsIterable = buffer;
    void (async () => {
      const rawHandle = await this.#session.subscribe({
        channels: ["lifecycle", "tools"],
        namespaces: [this.namespace],
      });
      const discovery = new SubgraphDiscoveryHandle(
        rawHandle,
        this.#session,
        this.namespace
      );
      for await (const sub of discovery) {
        buffer.push(sub);
      }
      buffer.close();
    })();
    return buffer;
  }

  get subagents(): AsyncIterable<SubagentHandle> {
    if (this.#subagentsIterable) return this.#subagentsIterable;
    const buffer = new MultiCursorBuffer<SubagentHandle>();
    this.#subagentsIterable = buffer;
    void (async () => {
      const rawHandle = await this.#session.subscribe({
        channels: ["tools", "lifecycle"],
        namespaces: [this.namespace],
      });
      const { SubagentDiscoveryHandle: Discovery } =
        await import("./subagents.js");
      const discovery = new Discovery(rawHandle, this.#session);
      for await (const sub of discovery) {
        buffer.push(sub);
      }
      buffer.close();
    })();
    return buffer;
  }

  get audio(): AsyncIterable<AudioMedia> {
    this.#ensureMediaDispatcher();
    return this.#audioBuffer!;
  }

  get images(): AsyncIterable<ImageMedia> {
    this.#ensureMediaDispatcher();
    return this.#imagesBuffer!;
  }

  get video(): AsyncIterable<VideoMedia> {
    this.#ensureMediaDispatcher();
    return this.#videoBuffer!;
  }

  get files(): AsyncIterable<FileMedia> {
    this.#ensureMediaDispatcher();
    return this.#filesBuffer!;
  }

  get output(): Promise<unknown> {
    void this.values;
    return this.#outputPromise!;
  }

  #ensureMediaDispatcher(): void {
    if (this.#mediaDispatcherStarted) return;
    this.#mediaDispatcherStarted = true;
    const audio = new MultiCursorBuffer<AudioMedia>();
    const images = new MultiCursorBuffer<ImageMedia>();
    const video = new MultiCursorBuffer<VideoMedia>();
    const files = new MultiCursorBuffer<FileMedia>();
    this.#audioBuffer = audio;
    this.#imagesBuffer = images;
    this.#videoBuffer = video;
    this.#filesBuffer = files;
    const assembler = new MediaAssembler({
      onAudio: (m: AudioMedia) => audio.push(m),
      onImage: (m: ImageMedia) => images.push(m),
      onVideo: (m: VideoMedia) => video.push(m),
      onFile: (m: FileMedia) => files.push(m),
    });
    void this.#startProjection(
      ["messages"],
      (event) => {
        if (event.method !== "messages") return;
        assembler.consume(event as MessagesEvent);
      },
      () => {
        assembler.close();
        audio.close();
        images.close();
        video.close();
        files.close();
      }
    );
  }

  /**
   * Create a raw channel subscription scoped to this subgraph's namespace.
   */
  subscribe<TChannel extends Channel>(
    channel: TChannel,
    options?: SubscribeOptions
  ): Promise<
    SubscriptionHandle<EventForChannel<TChannel>, YieldForChannel<TChannel>>
  >;
  subscribe<const TChannels extends readonly Channel[]>(
    channels: TChannels,
    options?: SubscribeOptions
  ): Promise<
    SubscriptionHandle<EventForChannels<TChannels>, YieldForChannels<TChannels>>
  >;
  subscribe(params: SubscribeParams): Promise<SubscriptionHandle<Event>>;
  subscribe(
    paramsOrChannels: SubscribeParams | Channel | string | readonly Channel[],
    options: SubscribeOptions = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    if (
      typeof paramsOrChannels === "object" &&
      !Array.isArray(paramsOrChannels) &&
      "channels" in paramsOrChannels
    ) {
      return this.#session.subscribe({
        ...paramsOrChannels,
        namespaces: paramsOrChannels.namespaces ?? [this.namespace],
      });
    }

    return this.#session.subscribe(paramsOrChannels as Channel, {
      ...options,
      namespaces: options.namespaces ?? [this.namespace],
    });
  }

  async #startProjection(
    channels: Channel[],
    onEvent: (event: Event) => void,
    onDone: () => void
  ): Promise<void> {
    try {
      const rawHandle = await this.#session.subscribe({
        channels,
        namespaces: [this.namespace],
      });
      for await (const event of rawHandle) {
        onEvent(event);
      }
    } finally {
      onDone();
    }
  }
}

/**
 * Async iterable that yields {@link SubgraphHandle} instances as new
 * subgraph namespaces are discovered from `lifecycle` events.
 *
 * Mirrors the in-process `run.subgraphs` pattern. A new subgraph is
 * discovered when a `lifecycle` event with `event: "started"` is
 * received at a namespace depth of exactly `parentDepth + 1`.
 */
export class SubgraphDiscoveryHandle implements AsyncIterable<SubgraphHandle> {
  readonly #source: SubscriptionHandle<Event>;
  readonly #session: Subscribable;
  readonly #parentNamespace: string[];
  readonly #discovered = new Set<string>();
  readonly #pendingToolStarts = new Map<string, ToolsEvent>();
  readonly #pendingToolCallHandles = new Map<string, SubgraphHandle>();
  readonly #queue: SubgraphHandle[] = [];
  readonly #waiters: Array<(value: IteratorResult<SubgraphHandle>) => void> =
    [];
  #sourcePump?: Promise<void>;
  #closed = false;

  constructor(
    source: SubscriptionHandle<Event>,
    session: Subscribable,
    parentNamespace: string[] = []
  ) {
    this.#source = source;
    this.#session = session;
    this.#parentNamespace = parentNamespace;
  }

  #emit(handle: SubgraphHandle): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value: handle });
    } else {
      this.#queue.push(handle);
    }
  }

  #processToolEvent(event: Event): boolean {
    if (event.method !== "tools") return false;
    const tools = event as ToolsEvent;
    const data = tools.params.data as Record<string, unknown>;
    if (data.event !== "tool-started") return true;

    const toolCallId = data.tool_call_id as string | undefined;
    if (!toolCallId) return true;

    const pendingHandle = this.#pendingToolCallHandles.get(toolCallId);
    if (pendingHandle) {
      pendingHandle.toolStartedEvent = tools;
      this.#pendingToolCallHandles.delete(toolCallId);
      return true;
    }

    this.#pendingToolStarts.set(toolCallId, tools);
    return true;
  }

  #processEvent(event: Event): SubgraphHandle | undefined {
    if (this.#processToolEvent(event)) return undefined;
    if (event.method !== "lifecycle") return undefined;
    const lifecycle = event as LifecycleEvent;
    if (lifecycle.params.data.event !== "started") return undefined;

    const ns = event.params.namespace;
    if (ns.length !== this.#parentNamespace.length + 1) return undefined;

    const isChild = this.#parentNamespace.every((seg, i) => ns[i] === seg);
    if (!isChild) return undefined;

    const nsKey = ns.join("/");
    if (this.#discovered.has(nsKey)) return undefined;
    this.#discovered.add(nsKey);

    const lastSegment = ns[ns.length - 1] ?? "";
    const colonIdx = lastSegment.lastIndexOf(":");
    let name: string;
    let index: number;
    if (colonIdx >= 0) {
      name = lastSegment.slice(0, colonIdx);
      const suffix = lastSegment.slice(colonIdx + 1);
      index = /^\d+$/.test(suffix) ? Number(suffix) : 0;
    } else {
      name = lastSegment;
      index = 0;
    }

    const data = lifecycle.params.data as unknown as Record<string, unknown>;
    const cause =
      data.cause && typeof data.cause === "object"
        ? (data.cause as LifecycleCause)
        : undefined;
    let toolStartedEvent: ToolsEvent | undefined;
    if (cause?.type === "toolCall") {
      const toolCallId = (cause as { tool_call_id?: string }).tool_call_id;
      if (toolCallId) {
        toolStartedEvent = this.#pendingToolStarts.get(toolCallId);
        this.#pendingToolStarts.delete(toolCallId);
      }
    }

    const handle = new SubgraphHandle(name, index, [...ns], this.#session, {
      cause,
      graphName: data.graph_name as string | undefined,
      toolStartedEvent,
    });
    if (cause?.type === "toolCall" && toolStartedEvent == null) {
      const toolCallId = (cause as { tool_call_id?: string }).tool_call_id;
      if (toolCallId) this.#pendingToolCallHandles.set(toolCallId, handle);
    }
    return handle;
  }

  #start(): void {
    if (this.#sourcePump) return;
    this.#sourcePump = (async () => {
      for await (const event of this.#source) {
        const handle = this.#processEvent(event);
        if (!handle) continue;
        this.#emit(handle);
      }
      this.#pendingToolStarts.clear();
      this.#pendingToolCallHandles.clear();
      this.#closed = true;
      while (this.#waiters.length > 0) {
        this.#waiters.shift()?.({ done: true, value: undefined });
      }
    })();
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#source.unsubscribe();
  }

  [Symbol.asyncIterator](): AsyncIterator<SubgraphHandle> {
    this.#start();
    return {
      next: async () => {
        if (this.#queue.length > 0) {
          return { done: false, value: this.#queue.shift()! };
        }
        if (this.#closed) {
          return { done: true, value: undefined };
        }
        return await new Promise<IteratorResult<SubgraphHandle>>((resolve) => {
          this.#waiters.push(resolve);
        });
      },
      return: async () => {
        await this.close();
        return { done: true, value: undefined };
      },
    };
  }
}
