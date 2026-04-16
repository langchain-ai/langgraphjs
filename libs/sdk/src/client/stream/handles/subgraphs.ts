import type {
  Channel,
  Event,
  LifecycleEvent,
  SubscribeParams,
} from "@langchain/protocol";
import type { SubscriptionHandle } from "../index.js";
import type {
  EventForChannel,
  EventForChannels,
  SubscribeOptions,
  YieldForChannel,
  YieldForChannels,
} from "../types.js";
import type { ToolSubscriptionHandle } from "./tools.js";
import type { ValuesSubscriptionHandle } from "./values.js";
import type { StreamingMessageSubscriptionHandle } from "./messages.js";
import type { SubagentDiscoveryHandle } from "./subagents.js";

/**
 * Minimal subscription surface that {@link SubgraphHandle} and
 * {@link SubagentHandle} delegate to. Typed to match the
 * `Session.subscribe` overloads without importing the full `Session`
 * class (avoids circular dependency).
 */
export interface Subscribable {
  subscribe(
    projection: "toolCalls",
    options?: SubscribeOptions
  ): Promise<ToolSubscriptionHandle>;
  subscribe(
    projection: "values",
    options?: SubscribeOptions
  ): Promise<ValuesSubscriptionHandle>;
  subscribe(
    projection: "messages",
    options?: SubscribeOptions
  ): Promise<StreamingMessageSubscriptionHandle>;
  subscribe(
    projection: "subgraphs",
    options?: SubscribeOptions
  ): Promise<SubgraphDiscoveryHandle>;
  subscribe(
    projection: "subagents",
    options?: SubscribeOptions
  ): Promise<SubagentDiscoveryHandle>;
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
  subscribe(
    params: SubscribeParams
  ): Promise<SubscriptionHandle<Event>>;
}

/**
 * Discovered subgraph within a streaming session.
 *
 * Mirrors the in-process `SubgraphRunStream` pattern: each subgraph
 * has `name`, `index`, `namespace`, and a `subscribe()` method that
 * creates namespace-scoped subscriptions automatically.
 *
 * When the server includes `triggerCallId` on the lifecycle event,
 * clients can correlate this subgraph with the parent tool call that
 * spawned it (e.g., to extract task input or match output).
 *
 * ```ts
 * for await (const sub of session.subscribe("subgraphs")) {
 *   console.log(sub.name, sub.triggerCallId);
 *   const values = await sub.subscribe("values");
 *   const tools = await sub.subscribe("tools");
 * }
 * ```
 */
export class SubgraphHandle {
  readonly name: string;
  readonly index: number;
  readonly namespace: string[];
  readonly triggerCallId?: string;
  readonly graphName?: string;
  readonly #session: Subscribable;
  #outputPromise?: Promise<unknown>;

  constructor(
    name: string,
    index: number,
    namespace: string[],
    session: Subscribable,
    options?: { triggerCallId?: string; graphName?: string }
  ) {
    this.name = name;
    this.index = index;
    this.namespace = namespace;
    this.triggerCallId = options?.triggerCallId;
    this.graphName = options?.graphName;
    this.#session = session;
  }

  /**
   * Resolves with the final state value when this subgraph completes.
   * Lazily subscribes to `values` at this subgraph's namespace on first
   * access. Mirrors the in-process `SubgraphRunStream.output`.
   */
  get output(): Promise<unknown> {
    if (!this.#outputPromise) {
      this.#outputPromise = this.#session
        .subscribe("values", { namespaces: [this.namespace] })
        .then((handle) => handle.output);
    }
    return this.#outputPromise;
  }

  /**
   * Create a subscription scoped to this subgraph's namespace.
   *
   * Same overloads as `Session.subscribe` — known channels return
   * assembled handles, others return raw `SubscriptionHandle`.
   */
  subscribe(
    projection: "toolCalls",
    options?: SubscribeOptions
  ): Promise<ToolSubscriptionHandle>;
  subscribe(
    projection: "values",
    options?: SubscribeOptions
  ): Promise<ValuesSubscriptionHandle>;
  subscribe(
    projection: "messages",
    options?: SubscribeOptions
  ): Promise<StreamingMessageSubscriptionHandle>;
  subscribe(
    projection: "subgraphs",
    options?: SubscribeOptions
  ): Promise<SubgraphDiscoveryHandle>;
  subscribe(
    projection: "subagents",
    options?: SubscribeOptions
  ): Promise<SubagentDiscoveryHandle>;
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

    return this.#session.subscribe(
      paramsOrChannels as Channel,
      { ...options, namespaces: options.namespaces ?? [this.namespace] }
    );
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
export class SubgraphDiscoveryHandle
  implements AsyncIterable<SubgraphHandle>
{
  readonly #source: SubscriptionHandle<Event>;
  readonly #session: Subscribable;
  readonly #parentNamespace: string[];
  readonly #discovered = new Set<string>();
  readonly #queue: SubgraphHandle[] = [];
  readonly #waiters: Array<
    (value: IteratorResult<SubgraphHandle>) => void
  > = [];
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

  #processEvent(event: Event): SubgraphHandle | undefined {
    if (event.method !== "lifecycle") return undefined;
    const lifecycle = event as LifecycleEvent;
    if (lifecycle.params.data.event !== "started") return undefined;

    const ns = event.params.namespace;
    if (ns.length !== this.#parentNamespace.length + 1) return undefined;

    const isChild = this.#parentNamespace.every(
      (seg, i) => ns[i] === seg
    );
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
    return new SubgraphHandle(name, index, [...ns], this.#session, {
      triggerCallId: data.trigger_call_id as string | undefined,
      graphName: data.graph_name as string | undefined,
    });
  }

  #start(): void {
    if (this.#sourcePump) return;
    this.#sourcePump = (async () => {
      for await (const event of this.#source) {
        const handle = this.#processEvent(event);
        if (!handle) continue;

        const waiter = this.#waiters.shift();
        if (waiter) {
          waiter({ done: false, value: handle });
        } else {
          this.#queue.push(handle);
        }
      }
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
