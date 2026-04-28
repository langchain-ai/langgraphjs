/**
 * Generic "triggered subgraph" discovery.
 *
 * A *triggered subgraph* is any subgraph whose `lifecycle.started`
 * event carries a non-empty `cause` (a discriminated union declared
 * by the protocol — e.g. `{ type: "toolCall", tool_call_id }`,
 * `{ type: "send", from_node }`, `{ type: "edge", from_node }`).
 *
 * This primitive is deliberately product-agnostic: it only keys on
 * `cause.type` and the `cause` payload. Product packages (e.g.
 * `deepagentsjs`) may wrap it to provide product-specific handles —
 * for example, a deepagents "subagent" is a triggered subgraph where
 * `cause.type === "toolCall"` and the correlated `tool-started`
 * event has `tool_name === "task"`. That interpretation does not
 * belong in the SDK.
 */
import type {
  Event,
  LifecycleCause,
  LifecycleEvent,
  ToolsEvent,
} from "@langchain/protocol";
import type { SubscriptionHandle } from "../index.js";
import { SubgraphHandle, type Subscribable } from "./subgraphs.js";

/**
 * A subgraph discovered via a non-empty `lifecycle.started.cause`.
 *
 * Extends {@link SubgraphHandle} with `toolStartedEvent` — populated
 * when `cause.type === "toolCall"` and the matching `tool-started`
 * event has already been observed on the `tools` channel. Product
 * wrappers can read `tool_name`, `input`, etc. from the raw event
 * without re-subscribing.
 */
export class TriggeredSubgraphHandle extends SubgraphHandle {
  /**
   * Raw `tool-started` event that triggered this subgraph, when
   * `cause.type === "toolCall"` and the event has been observed on
   * the `tools` channel. `undefined` otherwise.
   */
  readonly toolStartedEvent?: ToolsEvent;

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
    super(name, index, namespace, session, {
      cause: options?.cause,
      graphName: options?.graphName,
    });
    this.toolStartedEvent = options?.toolStartedEvent;
  }
}

type PendingToolStart = {
  event: ToolsEvent;
};

/**
 * Async iterable that yields {@link TriggeredSubgraphHandle} instances
 * as subgraphs with a non-empty `cause` are discovered.
 *
 * Subscribes to both `lifecycle` and `tools` channels. The `tools`
 * channel is used purely to attach the `tool-started` event to
 * handles triggered by `cause.type === "toolCall"`.
 */
export class TriggeredSubgraphDiscoveryHandle implements AsyncIterable<TriggeredSubgraphHandle> {
  readonly #source: SubscriptionHandle<Event>;
  readonly #session: Subscribable;
  readonly #discovered = new Set<string>();
  readonly #pendingToolStarts = new Map<string, PendingToolStart>();
  readonly #pendingLifecycles = new Map<
    string,
    {
      ns: string[];
      cause: LifecycleCause;
      graphName?: string;
      name: string;
      index: number;
    }
  >();
  readonly #queue: TriggeredSubgraphHandle[] = [];
  readonly #waiters: Array<
    (value: IteratorResult<TriggeredSubgraphHandle>) => void
  > = [];
  #sourcePump?: Promise<void>;
  #closed = false;

  constructor(source: SubscriptionHandle<Event>, session: Subscribable) {
    this.#source = source;
    this.#session = session;
  }

  #emit(handle: TriggeredSubgraphHandle): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value: handle });
    } else {
      this.#queue.push(handle);
    }
  }

  #processEvent(event: Event): void {
    if (event.method === "tools") {
      const tools = event as ToolsEvent;
      const data = tools.params.data as Record<string, unknown>;
      if (data.event !== "tool-started") return;
      const toolCallId = data.tool_call_id as string | undefined;
      if (!toolCallId) return;

      const pendingLifecycle = this.#pendingLifecycles.get(toolCallId);
      if (pendingLifecycle) {
        this.#pendingLifecycles.delete(toolCallId);
        this.#emit(
          new TriggeredSubgraphHandle(
            pendingLifecycle.name,
            pendingLifecycle.index,
            pendingLifecycle.ns,
            this.#session,
            {
              cause: pendingLifecycle.cause,
              graphName: pendingLifecycle.graphName,
              toolStartedEvent: tools,
            }
          )
        );
        return;
      }

      this.#pendingToolStarts.set(toolCallId, { event: tools });
      return;
    }

    if (event.method !== "lifecycle") return;
    const lifecycle = event as LifecycleEvent;
    if (lifecycle.params.data.event !== "started") return;
    const data = lifecycle.params.data as unknown as Record<string, unknown>;
    const cause = data.cause as LifecycleCause | undefined;
    if (!cause) return;

    const ns = event.params.namespace;
    const nsKey = ns.join("/");
    if (this.#discovered.has(nsKey)) return;
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

    const graphName = data.graph_name as string | undefined;

    if (cause.type === "toolCall") {
      const toolCallId = (cause as { tool_call_id?: string }).tool_call_id;
      if (toolCallId) {
        const pending = this.#pendingToolStarts.get(toolCallId);
        if (pending) {
          this.#pendingToolStarts.delete(toolCallId);
          this.#emit(
            new TriggeredSubgraphHandle(name, index, [...ns], this.#session, {
              cause,
              graphName,
              toolStartedEvent: pending.event,
            })
          );
          return;
        }

        this.#pendingLifecycles.set(toolCallId, {
          ns: [...ns],
          cause,
          graphName,
          name,
          index,
        });
        return;
      }
    }

    this.#emit(
      new TriggeredSubgraphHandle(name, index, [...ns], this.#session, {
        cause,
        graphName,
      })
    );
  }

  #start(): void {
    if (this.#sourcePump) return;
    this.#sourcePump = (async () => {
      for await (const event of this.#source) {
        this.#processEvent(event);
      }
      for (const pending of this.#pendingLifecycles.values()) {
        this.#emit(
          new TriggeredSubgraphHandle(
            pending.name,
            pending.index,
            pending.ns,
            this.#session,
            { cause: pending.cause, graphName: pending.graphName }
          )
        );
      }
      this.#pendingLifecycles.clear();
      this.#pendingToolStarts.clear();
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

  [Symbol.asyncIterator](): AsyncIterator<TriggeredSubgraphHandle> {
    this.#start();
    return {
      next: async () => {
        if (this.#queue.length > 0) {
          return { done: false, value: this.#queue.shift()! };
        }
        if (this.#closed) {
          return { done: true, value: undefined };
        }
        return await new Promise<IteratorResult<TriggeredSubgraphHandle>>(
          (resolve) => {
            this.#waiters.push(resolve);
          }
        );
      },
      return: async () => {
        await this.close();
        return { done: true, value: undefined };
      },
    };
  }
}
