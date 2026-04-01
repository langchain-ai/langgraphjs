import {
  AIMessage,
  type ContentBlock as CoreContentBlock,
  type UsageMetadata,
} from "@langchain/core/messages";
import type {
  ChatModelStreamEvent,
  ContentBlockDelta as CoreContentBlockDelta,
} from "@langchain/core/language_models/event";
import type {
  ContentBlock,
  FinalizedContentBlock,
  MessageMetadata,
  MessagesEvent,
  UsageInfo,
} from "@langchain/protocol";

import { MultiCursorBuffer } from "./multi-cursor-buffer.js";

type TextContentStream = AsyncIterable<string> &
  PromiseLike<string> & { full: AsyncIterable<string> };

type UsageMetadataStream = AsyncIterable<UsageMetadata> &
  PromiseLike<UsageMetadata | undefined>;

type ToolCallsStream = AsyncIterable<CoreContentBlock.Tools.ToolCall> &
  PromiseLike<Array<CoreContentBlock.Tools.ToolCall>> & {
    full: AsyncIterable<Array<CoreContentBlock.Tools.ToolCall>>;
  };

function applyCoreContentDelta(
  target: CoreContentBlock,
  delta: CoreContentBlock
): CoreContentBlock {
  if (target.type !== delta.type) {
    return structuredClone(delta);
  }

  switch (delta.type) {
    case "text":
      return {
        ...target,
        ...delta,
        text: `${"text" in target ? target.text : ""}${delta.text}`,
      } as CoreContentBlock;
    case "reasoning":
      return {
        ...target,
        ...delta,
        reasoning: `${"reasoning" in target ? target.reasoning : ""}${delta.reasoning}`,
      } as CoreContentBlock;
    case "tool_call_chunk":
    case "server_tool_call_chunk": {
      const merged = { ...target, ...delta } as Record<string, unknown>;
      if (delta.id == null && "id" in target && target.id != null) {
        merged.id = target.id;
      }
      if (delta.name == null && "name" in target && target.name != null) {
        merged.name = target.name;
      }
      merged.args = `${("args" in target ? target.args : "") ?? ""}${delta.args ?? ""}`;
      return merged as unknown as CoreContentBlock;
    }
    default:
      return { ...target, ...delta } as CoreContentBlock;
  }
}

function coreContentBlockFromDelta(
  delta: CoreContentBlockDelta,
  current?: CoreContentBlock
): CoreContentBlock {
  switch (delta.type) {
    case "text-delta":
      return { type: "text", text: delta.text } as CoreContentBlock;
    case "reasoning-delta":
      return {
        type: "reasoning",
        reasoning: delta.reasoning,
      } as CoreContentBlock;
    case "data-delta": {
      const merged = { ...(current ?? {}), data: delta.data } as Record<
        string,
        unknown
      >;
      if (delta.encoding) merged.encoding = delta.encoding;
      return merged as unknown as CoreContentBlock;
    }
    case "block-delta":
      return delta.fields as CoreContentBlock;
  }
}

function applyCoreEventDelta(
  current: CoreContentBlock | undefined,
  event: Extract<ChatModelStreamEvent, { event: "content-block-delta" }> & {
    content?: CoreContentBlock;
  }
): CoreContentBlock {
  if (event.content) {
    return current
      ? applyCoreContentDelta(current, event.content)
      : event.content;
  }

  switch (event.delta.type) {
    case "text-delta":
      if (current?.type === "text") {
        return {
          ...current,
          text: `${"text" in current ? current.text : ""}${event.delta.text}`,
        } as CoreContentBlock;
      }
      return coreContentBlockFromDelta(event.delta, current);
    case "reasoning-delta":
      if (current?.type === "reasoning") {
        return {
          ...current,
          reasoning: `${"reasoning" in current ? current.reasoning : ""}${event.delta.reasoning}`,
        } as CoreContentBlock;
      }
      return coreContentBlockFromDelta(event.delta, current);
    case "data-delta": {
      const merged = { ...(current ?? {}) } as Record<string, unknown>;
      merged.data = `${(merged.data as string | undefined) ?? ""}${event.delta.data}`;
      if (event.delta.encoding) merged.encoding = event.delta.encoding;
      return merged as unknown as CoreContentBlock;
    }
    case "block-delta":
      return {
        ...(current ?? {}),
        ...event.delta.fields,
      } as CoreContentBlock;
  }
}

function normalizeUsage(
  usage: UsageInfo | Partial<UsageMetadata> | undefined
): UsageMetadata | undefined {
  if (!usage) return undefined;
  return {
    ...usage,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  };
}

/**
 * Mutable view of a streamed message as message and content-block events are
 * assembled into a single structure.
 */
export interface AssembledMessage {
  id: string;
  namespace: string[];
  blocks: ContentBlock[];
  node?: string;
  usage?: UsageInfo;
  metadata?: MessageMetadata;
  finishMetadata?: Record<string, any>;
  error?: {
    message: string;
    code?: string;
  };
}

/**
 * Symbol keys for assembler → StreamingMessage communication.
 * Module-private: invisible to external consumers, accessible to
 * {@link StreamingMessageAssembler} within this file.
 */
const PUSH_TEXT: unique symbol = Symbol("pushText");
const PUSH_REASONING: unique symbol = Symbol("pushReasoning");
const PUSH_EVENT: unique symbol = Symbol("pushEvent");
const UPDATE_CONTEXT: unique symbol = Symbol("updateContext");
const FINISH: unique symbol = Symbol("finish");
const ERROR: unique symbol = Symbol("error");

/**
 * Live streaming view of a single message lifecycle, matching the
 * in-process `ChatModelStream` dual-interface pattern.
 *
 * - `text` / `reasoning`: iterate for streaming deltas, or await for
 *   the full concatenated string after the message completes.
 * - `usage`: promise that resolves with token usage on message-finish.
 * - `blocks`: the assembled content blocks (updated as deltas arrive).
 *
 * Created by {@link StreamingMessageAssembler} and yielded by
 * the `session.messages` lazy getter.
 */
export class StreamingMessage
  implements AsyncIterable<ChatModelStreamEvent>, PromiseLike<AIMessage>
{
  readonly id: string;
  readonly namespace: string[];
  node: string | undefined;
  readonly metadata: MessageMetadata | undefined;
  readonly assembled: AssembledMessage;
  readonly #events = new MultiCursorBuffer<ChatModelStreamEvent>();

  #textChunks: string[] = [];
  #reasoningChunks: string[] = [];
  #textWaiters: Array<() => void> = [];
  #reasoningWaiters: Array<() => void> = [];
  #textDone = false;
  #reasoningDone = false;

  #resolveText!: (v: string) => void;
  #resolveReasoning!: (v: string) => void;
  readonly #textPromise: Promise<string>;
  readonly #reasoningPromise: Promise<string>;

  constructor(assembled: AssembledMessage) {
    this.id = assembled.id;
    this.assembled = assembled;
    this.namespace = assembled.namespace;
    this.node = assembled.node;
    this.metadata = assembled.metadata;
    this.#textPromise = new Promise<string>((r) => {
      this.#resolveText = r;
    });
    this.#reasoningPromise = new Promise<string>((r) => {
      this.#resolveReasoning = r;
    });
  }

  get text(): TextContentStream {
    const chunks = this.#textChunks;
    const waiters = this.#textWaiters;
    const getDone = () => this.#textDone;
    let cursor = 0;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            while (true) {
              if (cursor < chunks.length) {
                return { done: false, value: chunks[cursor++] };
              }
              if (getDone()) {
                return { done: true, value: undefined };
              }
              await new Promise<void>((resolve) => {
                waiters.push(resolve);
              });
            }
          },
        };
      },
      then: this.#textPromise.then.bind(this.#textPromise),
      full: {
        async *[Symbol.asyncIterator]() {
          let accumulated = "";
          for await (const chunk of {
            [Symbol.asyncIterator]: () =>
              ({
                next: async (): Promise<IteratorResult<string>> => {
                  while (true) {
                    if (cursor < chunks.length) {
                      return { done: false, value: chunks[cursor++] };
                    }
                    if (getDone()) {
                      return { done: true, value: undefined };
                    }
                    await new Promise<void>((resolve) => {
                      waiters.push(resolve);
                    });
                  }
                },
              }) satisfies AsyncIterator<string>,
          }) {
            accumulated += chunk;
            yield accumulated;
          }
        },
      },
    };
  }

  get reasoning(): TextContentStream {
    const chunks = this.#reasoningChunks;
    const waiters = this.#reasoningWaiters;
    const getDone = () => this.#reasoningDone;
    let cursor = 0;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            while (true) {
              if (cursor < chunks.length) {
                return { done: false, value: chunks[cursor++] };
              }
              if (getDone()) {
                return { done: true, value: undefined };
              }
              await new Promise<void>((resolve) => {
                waiters.push(resolve);
              });
            }
          },
        };
      },
      then: this.#reasoningPromise.then.bind(this.#reasoningPromise),
      full: {
        async *[Symbol.asyncIterator]() {
          let accumulated = "";
          for await (const chunk of {
            [Symbol.asyncIterator]: () =>
              ({
                next: async (): Promise<IteratorResult<string>> => {
                  while (true) {
                    if (cursor < chunks.length) {
                      return { done: false, value: chunks[cursor++] };
                    }
                    if (getDone()) {
                      return { done: true, value: undefined };
                    }
                    await new Promise<void>((resolve) => {
                      waiters.push(resolve);
                    });
                  }
                },
              }) satisfies AsyncIterator<string>,
          }) {
            accumulated += chunk;
            yield accumulated;
          }
        },
      },
    };
  }

  get usage(): UsageMetadataStream {
    const promise = (async () => {
      let usage: UsageMetadata | undefined;
      for await (const snapshot of this.#usageIterator()) {
        usage = snapshot;
      }
      return usage;
    })();
    return {
      [Symbol.asyncIterator]: () => this.#usageIterator(),
      then: promise.then.bind(promise),
    };
  }

  get toolCalls(): ToolCallsStream {
    const events = this.#events;
    const iterator = async function* () {
      for await (const event of events) {
        if (
          event.event === "content-block-finish" &&
          event.content.type === "tool_call"
        ) {
          yield event.content as CoreContentBlock.Tools.ToolCall;
        }
      }
    };
    return {
      [Symbol.asyncIterator]: iterator,
      then: async (onfulfilled, onrejected) => {
        try {
          const calls: CoreContentBlock.Tools.ToolCall[] = [];
          for await (const call of iterator()) calls.push(call);
          return onfulfilled ? onfulfilled(calls) : (calls as never);
        } catch (err) {
          if (onrejected) return onrejected(err);
          throw err;
        }
      },
      full: {
        async *[Symbol.asyncIterator]() {
          const calls: CoreContentBlock.Tools.ToolCall[] = [];
          for await (const call of iterator()) {
            calls.push(call);
            yield [...calls];
          }
        },
      },
    };
  }

  get output(): PromiseLike<AIMessage> {
    return { then: (onf, onr) => this.#assembleMessage().then(onf, onr) };
  }

  get blocks(): ContentBlock[] {
    return this.assembled.blocks;
  }

  [Symbol.asyncIterator](): AsyncIterator<ChatModelStreamEvent> {
    return this.#events[Symbol.asyncIterator]();
  }

  then<TResult1 = AIMessage, TResult2 = never>(
    onfulfilled?:
      | ((value: AIMessage) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.#assembleMessage().then(onfulfilled, onrejected);
  }

  async *#usageIterator(): AsyncGenerator<UsageMetadata> {
    for await (const event of this.#events) {
      if (event.event === "message-start" && event.usage) {
        yield normalizeUsage(event.usage)!;
      } else if (event.event === "message-finish" && event.usage) {
        yield normalizeUsage(event.usage)!;
      }
    }
  }

  async #assembleMessage(): Promise<AIMessage> {
    const contentBlocks: Array<CoreContentBlock | undefined> = [];
    let id: string | undefined;
    let usage: UsageMetadata | undefined;
    let metadata: Record<string, unknown> = {};
    let finishReason: string | undefined;

    for await (const event of this.#events) {
      switch (event.event) {
        case "message-start":
          id = event.id ?? id;
          if (event.usage) usage = normalizeUsage(event.usage);
          break;
        case "content-block-start":
          contentBlocks[event.index] = event.content;
          break;
        case "content-block-delta": {
          const current = contentBlocks[event.index];
          contentBlocks[event.index] = applyCoreEventDelta(current, event);
          break;
        }
        case "content-block-finish":
          contentBlocks[event.index] = event.content;
          break;
        case "message-finish":
          finishReason = event.reason;
          if (event.usage) usage = normalizeUsage(event.usage);
          if (event.responseMetadata) {
            metadata = {
              ...metadata,
              ...event.responseMetadata,
            };
          }
          break;
        default:
          break;
      }
    }

    return new AIMessage({
      id,
      content: contentBlocks.filter(
        (block): block is CoreContentBlock => block != null
      ),
      usage_metadata: usage,
      response_metadata: {
        ...metadata,
        ...(finishReason ? { finish_reason: finishReason } : {}),
        output_version: "v1" as const,
      },
    });
  }

  [PUSH_EVENT](event: ChatModelStreamEvent): void {
    this.#events.push(event);
  }

  [UPDATE_CONTEXT](event: MessagesEvent): void {
    this.node = event.params.node ?? this.node;
  }

  [PUSH_TEXT](delta: string): void {
    this.#textChunks.push(delta);
    // Wake every caught-up iterator so each one advances its own cursor.
    // Iterators re-check `chunks.length` before delivering, which keeps
    // the cursor the single source of truth for what a consumer has seen.
    const pending = this.#textWaiters.splice(0, this.#textWaiters.length);
    for (const waiter of pending) waiter();
  }

  [PUSH_REASONING](delta: string): void {
    this.#reasoningChunks.push(delta);
    const pending = this.#reasoningWaiters.splice(
      0,
      this.#reasoningWaiters.length
    );
    for (const waiter of pending) waiter();
  }

  [FINISH](): void {
    this.#textDone = true;
    this.#reasoningDone = true;
    this.#resolveText(this.#textChunks.join(""));
    this.#resolveReasoning(this.#reasoningChunks.join(""));
    const textPending = this.#textWaiters.splice(0, this.#textWaiters.length);
    for (const waiter of textPending) waiter();
    const reasoningPending = this.#reasoningWaiters.splice(
      0,
      this.#reasoningWaiters.length
    );
    for (const waiter of reasoningPending) waiter();
    this.#events.close();
  }

  [ERROR](): void {
    this[FINISH]();
  }
}

/**
 * Public view yielded by message projections.
 *
 * `StreamingMessage` is PromiseLike so callers can still `await` a message
 * object directly, but TypeScript applies `Awaited<T>` to values produced by
 * `for await`. Exposing a non-thenable view keeps loop variables typed as the
 * streaming handle instead of as the finalized `AIMessage`.
 */
export type StreamingMessageHandle = Omit<StreamingMessage, "then">;

export function toStreamingMessageHandle(
  message: StreamingMessage
): StreamingMessageHandle {
  return new Proxy(message, {
    get(target, prop) {
      if (prop === "then") return undefined;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(target, prop) {
      if (prop === "then") return false;
      return prop in target;
    },
  }) as StreamingMessageHandle;
}

/**
 * Emitted by `MessageAssembler.consume()` to describe how a message changed in
 * response to a single protocol event.
 */
export type MessageAssemblyUpdate =
  | {
      kind: "message-start";
      key: string;
      message: AssembledMessage;
      event: MessagesEvent;
    }
  | {
      kind: "content-block-start" | "content-block-delta";
      key: string;
      message: AssembledMessage;
      index: number;
      block: ContentBlock;
      event: MessagesEvent;
    }
  | {
      kind: "content-block-finish";
      key: string;
      message: AssembledMessage;
      index: number;
      block: FinalizedContentBlock;
      event: MessagesEvent;
    }
  | {
      kind: "usage";
      key: string;
      message: AssembledMessage;
      event: MessagesEvent;
    }
  | {
      kind: "message-finish";
      key: string;
      message: AssembledMessage;
      event: MessagesEvent;
    }
  | {
      kind: "message-error";
      key: string;
      message: AssembledMessage;
      event: MessagesEvent;
    };

function cloneBlock<T extends ContentBlock>(block: T): T {
  return structuredClone(block);
}

function ensureBlockIndex(
  blocks: ContentBlock[],
  index: number,
  fallback: ContentBlock
): ContentBlock {
  while (blocks.length <= index) {
    blocks.push(cloneBlock(fallback));
  }
  return blocks[index] ?? (blocks[index] = cloneBlock(fallback));
}

function blockFromDelta(
  delta: CoreContentBlockDelta,
  current?: ContentBlock
): ContentBlock {
  return coreContentBlockFromDelta(
    delta,
    current as unknown as CoreContentBlock | undefined
  ) as unknown as ContentBlock;
}

function applyContentDelta(
  target: ContentBlock,
  delta: ContentBlock
): ContentBlock {
  if (target.type !== delta.type) {
    return cloneBlock(delta);
  }

  switch (delta.type) {
    case "text":
      return {
        ...target,
        ...delta,
        text: `${"text" in target ? target.text : ""}${delta.text}`,
      } as ContentBlock;
    case "reasoning":
      return {
        ...target,
        ...delta,
        reasoning: `${"reasoning" in target ? target.reasoning : ""}${delta.reasoning}`,
      } as ContentBlock;
    case "tool_call_chunk":
    case "server_tool_call_chunk": {
      // Spread target first, then delta — but preserve target's
      // ``id``/``name`` when the delta explicitly sets them to
      // null/undefined.  Some providers (notably Anthropic via the
      // langchain-core compat bridge) only attach the tool-call
      // identifiers to the first ``content-block-start`` chunk; every
      // subsequent ``input_json_delta`` chunk carries ``id=null,
      // name=null``.  A naive ``{...target, ...delta}`` spread
      // overwrites the captured identifiers with null, which in turn
      // makes downstream consumers (e.g. ``extractToolCallChunks`` in
      // ``assembled-to-message.ts``) drop the chunk on the floor until
      // the final ``content-block-finish`` event promotes it to a
      // finalized ``tool_call`` — causing tool-call cards to appear
      // all-at-once at the end of the turn instead of incrementally.
      const merged = { ...target, ...delta } as Record<string, unknown>;
      if (delta.id == null && "id" in target && target.id != null) {
        merged.id = target.id;
      }
      if (delta.name == null && "name" in target && target.name != null) {
        merged.name = target.name;
      }
      merged.args = `${("args" in target ? target.args : "") ?? ""}${delta.args ?? ""}`;
      return merged as unknown as ContentBlock;
    }
    default:
      return {
        ...target,
        ...delta,
      } as ContentBlock;
  }
}

function messageKeyFor(event: MessagesEvent): string {
  const { namespace, node, data } = event.params;
  const namespaceKey = namespace.join("/");
  const messageId = data.event === "message-start" ? (data.id ?? "") : "";
  return `${namespaceKey}::${node ?? ""}::${messageId}`;
}

function toChatModelStreamEvent(event: MessagesEvent): ChatModelStreamEvent {
  return event.params.data as unknown as ChatModelStreamEvent;
}

/**
 * Incrementally assembles `messages` events into complete message objects.
 */
export class MessageAssembler {
  private readonly activeMessages = new Map<string, AssembledMessage>();
  private readonly activeByNamespaceNode = new Map<string, string>();

  /**
   * Applies a single message event and returns the resulting assembly update.
   *
   * @param event - Incoming `messages` event to fold into the assembler state.
   */
  consume(event: MessagesEvent): MessageAssemblyUpdate {
    const data = event.params.data;
    const namespaceNodeKey = `${event.params.namespace.join("/")}::${event.params.node ?? ""}`;

    if (data.event === "message-start") {
      const key = messageKeyFor(event);
      this.activeByNamespaceNode.set(namespaceNodeKey, key);
      const message: AssembledMessage = {
        id: data.id,
        namespace: [...event.params.namespace],
        node: event.params.node,
        metadata: data.metadata,
        blocks: [],
      };
      this.activeMessages.set(key, message);
      return { kind: "message-start", key, message, event };
    }

    const activeKey = this.activeByNamespaceNode.get(namespaceNodeKey);
    if (!activeKey) {
      // A continuation event (delta/finish/error) arrived without a
      // prior `message-start`. This can happen on late-attaching
      // subscriptions when the server has already trimmed the
      // `message-start` from its replay buffer. Synthesize a minimal
      // active message so the assembler can still fold subsequent
      // events instead of hard-failing the caller.
      const syntheticKey = `${namespaceNodeKey}::`;
      this.activeByNamespaceNode.set(namespaceNodeKey, syntheticKey);
      const synthetic: AssembledMessage = {
        id: data.id,
        namespace: [...event.params.namespace],
        node: event.params.node,
        blocks: [],
      };
      this.activeMessages.set(syntheticKey, synthetic);
      return this.consume(event);
    }

    const message = this.activeMessages.get(activeKey);
    if (!message) {
      throw new Error(`No active message state found for key ${activeKey}`);
    }

    if ((data as { event?: string }).event === "usage") {
      message.usage = (data as { usage?: UsageInfo }).usage;
      return {
        kind: "usage",
        key: activeKey,
        message,
        event,
      };
    }

    switch (data.event) {
      case "content-block-start": {
        message.blocks[data.index] = cloneBlock(data.content);
        return {
          kind: "content-block-start",
          key: activeKey,
          message,
          index: data.index,
          block: data.content,
          event,
        };
      }
      case "content-block-delta": {
        const deltaEvent = data as typeof data & {
          content?: ContentBlock;
          delta?: CoreContentBlockDelta;
        };
        const deltaBlock =
          deltaEvent.content ??
          (deltaEvent.delta != null
            ? blockFromDelta(deltaEvent.delta, message.blocks[data.index])
            : undefined);
        if (deltaBlock == null) {
          throw new Error("Received content-block-delta without content");
        }
        const current = ensureBlockIndex(
          message.blocks,
          data.index,
          deltaBlock
        );
        message.blocks[data.index] =
          deltaEvent.content != null
            ? applyContentDelta(current, deltaEvent.content)
            : (applyCoreEventDelta(
                current as unknown as CoreContentBlock,
                data as unknown as Extract<
                  ChatModelStreamEvent,
                  { event: "content-block-delta" }
                >
              ) as unknown as ContentBlock);
        return {
          kind: "content-block-delta",
          key: activeKey,
          message,
          index: data.index,
          block: deltaBlock,
          event,
        };
      }
      case "content-block-finish": {
        message.blocks[data.index] = cloneBlock(data.content);
        return {
          kind: "content-block-finish",
          key: activeKey,
          message,
          index: data.index,
          block: data.content,
          event,
        };
      }
      case "message-finish": {
        message.usage = data.usage;
        message.finishMetadata = data.responseMetadata;
        this.activeMessages.delete(activeKey);
        this.activeByNamespaceNode.delete(namespaceNodeKey);
        return {
          kind: "message-finish",
          key: activeKey,
          message: structuredClone(message),
          event,
        };
      }
      case "error": {
        message.error = { message: data.message, code: data.code };
        this.activeMessages.delete(activeKey);
        this.activeByNamespaceNode.delete(namespaceNodeKey);
        return {
          kind: "message-error",
          key: activeKey,
          message: structuredClone(message),
          event,
        };
      }
    }
  }
}

/**
 * Assembles `messages` events into {@link StreamingMessage} instances
 * with live text/reasoning delta streams, matching the in-process
 * `ChatModelStream` dual-interface pattern.
 */
export class StreamingMessageAssembler {
  readonly #assembler = new MessageAssembler();
  readonly #activeStreaming = new Map<string, StreamingMessage>();

  /**
   * Folds a single event and returns a new {@link StreamingMessage}
   * when a `message-start` is seen, or `undefined` for continuation
   * events (deltas, finish, error).
   */
  consume(event: MessagesEvent): StreamingMessage | undefined {
    const update = this.#assembler.consume(event);
    if (update == null) return undefined;

    switch (update.kind) {
      case "message-start": {
        const streaming = new StreamingMessage(update.message);
        streaming[UPDATE_CONTEXT](update.event);
        streaming[PUSH_EVENT](toChatModelStreamEvent(update.event));
        this.#activeStreaming.set(update.key, streaming);
        return streaming;
      }
      case "content-block-start": {
        const streaming = this.#activeStreaming.get(update.key);
        if (streaming) {
          streaming[UPDATE_CONTEXT](update.event);
          streaming[PUSH_EVENT](toChatModelStreamEvent(update.event));
        }
        if (
          streaming &&
          update.block.type === "text" &&
          "text" in update.block &&
          update.block.text
        ) {
          streaming[PUSH_TEXT](update.block.text);
        }
        if (
          streaming &&
          update.block.type === "reasoning" &&
          "reasoning" in update.block &&
          update.block.reasoning
        ) {
          streaming[PUSH_REASONING](update.block.reasoning);
        }
        return undefined;
      }
      case "content-block-delta": {
        const streaming = this.#activeStreaming.get(update.key);
        if (!streaming) return undefined;
        streaming[UPDATE_CONTEXT](update.event);
        streaming[PUSH_EVENT](toChatModelStreamEvent(update.event));
        if (update.block.type === "text" && "text" in update.block) {
          streaming[PUSH_TEXT](update.block.text);
        }
        if (update.block.type === "reasoning" && "reasoning" in update.block) {
          streaming[PUSH_REASONING](update.block.reasoning);
        }
        return undefined;
      }
      case "content-block-finish": {
        const streaming = this.#activeStreaming.get(update.key);
        if (streaming) {
          streaming[UPDATE_CONTEXT](update.event);
          streaming[PUSH_EVENT](toChatModelStreamEvent(update.event));
        }
        return undefined;
      }
      case "usage": {
        const streaming = this.#activeStreaming.get(update.key);
        if (streaming) {
          streaming[UPDATE_CONTEXT](update.event);
          streaming[PUSH_EVENT](toChatModelStreamEvent(update.event));
        }
        return undefined;
      }
      case "message-finish": {
        const streaming = this.#activeStreaming.get(update.key);
        if (streaming) {
          streaming[UPDATE_CONTEXT](update.event);
          streaming[PUSH_EVENT](toChatModelStreamEvent(update.event));
          streaming[FINISH]();
          this.#activeStreaming.delete(update.key);
        }
        return undefined;
      }
      case "message-error": {
        const streaming = this.#activeStreaming.get(update.key);
        if (streaming) {
          streaming[UPDATE_CONTEXT](update.event);
          streaming[PUSH_EVENT](toChatModelStreamEvent(update.event));
          streaming[ERROR]();
          this.#activeStreaming.delete(update.key);
        }
        return undefined;
      }
    }
  }
}
