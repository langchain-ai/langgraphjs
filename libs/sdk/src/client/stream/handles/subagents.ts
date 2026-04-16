import type {
  Channel,
  Event,
  SubscribeParams,
  ToolsEvent,
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
import type {
  Subscribable,
  SubgraphDiscoveryHandle,
} from "./subgraphs.js";

/**
 * Discovered subagent within a streaming session. Mirrors the
 * in-process `SubagentRunStream` from DeepAgent.
 *
 * Each subagent is discovered when a `tool-started` event with
 * `tool_name === "task"` is observed. The `taskInput` and `output`
 * promises resolve from the task tool's lifecycle events.
 *
 * Use `.subscribe()` to create namespace-scoped subscriptions for
 * this subagent's child events (tools, messages, values, etc.).
 */
export class SubagentHandle {
  readonly name: string;
  readonly callId: string;
  readonly taskInput: Promise<string>;
  readonly output: Promise<unknown>;
  readonly namespace: string[];
  readonly #session: Subscribable;

  constructor(
    name: string,
    callId: string,
    namespace: string[],
    taskInput: Promise<string>,
    output: Promise<unknown>,
    session: Subscribable
  ) {
    this.name = name;
    this.callId = callId;
    this.namespace = namespace;
    this.taskInput = taskInput;
    this.output = output;
    this.#session = session;
  }

  /**
   * Create a subscription scoped to this subagent's namespace.
   * Delegates to the session with `namespaces: [this.namespace]`.
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
 * Async iterable that yields {@link SubagentHandle} instances as task
 * tool calls are discovered from the `tools` channel.
 *
 * Mirrors the in-process `createSubagentTransformer` from DeepAgent:
 * watches for `tool_name === "task"` with `tool-started`, extracts
 * `subagent_type` and `description` from the input, and resolves
 * `output` on `tool-finished`.
 */
export class SubagentDiscoveryHandle
  implements AsyncIterable<SubagentHandle>
{
  readonly #source: SubscriptionHandle<Event>;
  readonly #session: Subscribable;
  readonly #queue: SubagentHandle[] = [];
  readonly #waiters: Array<
    (value: IteratorResult<SubagentHandle>) => void
  > = [];
  readonly #pending = new Map<
    string,
    {
      resolveOutput: (v: unknown) => void;
      rejectOutput: (e: unknown) => void;
    }
  >();
  #sourcePump?: Promise<void>;
  #closed = false;

  constructor(
    source: SubscriptionHandle<Event>,
    session: Subscribable,
  ) {
    this.#source = source;
    this.#session = session;
  }

  #processEvent(event: Event): SubagentHandle | undefined {
    if (event.method !== "tools") return undefined;
    const tools = event as ToolsEvent;
    const data = tools.params.data;
    const toolCallId = (data as Record<string, unknown>)
      .tool_call_id as string;
    const toolName = (data as Record<string, unknown>)
      .tool_name as string;

    if (toolName === "task" && data.event === "tool-started") {
      const rawInput = (data as Record<string, unknown>).input;
      const input: { description?: string; subagent_type?: string } =
        typeof rawInput === "string"
          ? JSON.parse(rawInput)
          : ((rawInput as Record<string, unknown>) ?? {});

      const name = input.subagent_type ?? "unknown";
      const description = input.description ?? "";

      let resolveTaskInput!: (v: string) => void;
      let resolveOutput!: (v: unknown) => void;
      let rejectOutput!: (e: unknown) => void;

      const taskInput = new Promise<string>((r) => {
        resolveTaskInput = r;
      });
      const output = new Promise<unknown>((res, rej) => {
        resolveOutput = res;
        rejectOutput = rej;
      });

      resolveTaskInput(description);
      this.#pending.set(toolCallId, { resolveOutput, rejectOutput });

      const namespace = [...tools.params.namespace];

      return new SubagentHandle(
        name,
        toolCallId,
        namespace,
        taskInput,
        output,
        this.#session
      );
    }

    if (toolCallId) {
      const pending = this.#pending.get(toolCallId);
      if (pending) {
        if (data.event === "tool-finished") {
          pending.resolveOutput((data as Record<string, unknown>).output);
          this.#pending.delete(toolCallId);
        } else if (data.event === "tool-error") {
          const message =
            ((data as Record<string, unknown>).message as string) ??
            "unknown error";
          pending.rejectOutput(new Error(message));
          this.#pending.delete(toolCallId);
        }
      }
    }

    return undefined;
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
      for (const pending of this.#pending.values()) {
        pending.resolveOutput(undefined);
      }
      this.#pending.clear();
      while (this.#waiters.length > 0) {
        this.#waiters.shift()?.({ done: true, value: undefined });
      }
    })();
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#source.unsubscribe();
  }

  [Symbol.asyncIterator](): AsyncIterator<SubagentHandle> {
    this.#start();
    return {
      next: async () => {
        if (this.#queue.length > 0) {
          return { done: false, value: this.#queue.shift()! };
        }
        if (this.#closed) {
          return { done: true, value: undefined };
        }
        return await new Promise<IteratorResult<SubagentHandle>>((resolve) => {
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
