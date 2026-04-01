import type {
  Channel,
  Event,
  MessagesEvent,
  SubscribeParams,
  ToolsEvent,
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
import {
  type Subscribable,
  type SubgraphHandle,
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
 * Use lazy getters (`sub.messages`, `sub.toolCalls`, etc.) for
 * namespace-scoped projections.
 */
export class SubagentHandle {
  readonly name: string;
  readonly callId: string;
  readonly taskInput: Promise<string>;
  readonly output: Promise<unknown>;
  readonly namespace: string[];
  readonly #session: Subscribable;

  #messagesIterable?: AsyncIterable<StreamingMessage>;
  #toolCallsIterable?: AsyncIterable<AssembledToolCall>;
  #subgraphsIterable?: AsyncIterable<SubgraphHandle>;

  #mediaDispatcherStarted = false;
  #audioBuffer?: MultiCursorBuffer<AudioMedia>;
  #imagesBuffer?: MultiCursorBuffer<ImageMedia>;
  #videoBuffer?: MultiCursorBuffer<VideoMedia>;
  #filesBuffer?: MultiCursorBuffer<FileMedia>;

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

  get subgraphs(): AsyncIterable<SubgraphHandle> {
    if (this.#subgraphsIterable) return this.#subgraphsIterable;
    const buffer = new MultiCursorBuffer<SubgraphHandle>();
    this.#subgraphsIterable = buffer;
    void (async () => {
      const rawHandle = await this.#session.subscribe({
        channels: ["lifecycle"],
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

  /**
   * Create a raw channel subscription scoped to this subagent's namespace.
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
 * Async iterable that yields {@link SubagentHandle} instances as task
 * tool calls are discovered from the `tools` channel.
 *
 * Mirrors the in-process `createSubagentTransformer` from DeepAgent:
 * watches for `tool_name === "task"` with `tool-started`, extracts
 * `subagent_type` and `description` from the input, and resolves
 * `output` on `tool-finished`.
 */
export class SubagentDiscoveryHandle implements AsyncIterable<SubagentHandle> {
  readonly #source: SubscriptionHandle<Event>;
  readonly #session: Subscribable;
  readonly #queue: SubagentHandle[] = [];
  readonly #waiters: Array<(value: IteratorResult<SubagentHandle>) => void> =
    [];
  readonly #pending = new Map<
    string,
    {
      resolveOutput: (v: unknown) => void;
      rejectOutput: (e: unknown) => void;
    }
  >();
  #sourcePump?: Promise<void>;
  #closed = false;

  constructor(source: SubscriptionHandle<Event>, session: Subscribable) {
    this.#source = source;
    this.#session = session;
  }

  #processEvent(event: Event): SubagentHandle | undefined {
    if (event.method !== "tools") return undefined;
    const tools = event as ToolsEvent;
    const data = tools.params.data;
    const toolCallId = (data as Record<string, unknown>).tool_call_id as string;
    const toolName = (data as Record<string, unknown>).tool_name as string;

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
