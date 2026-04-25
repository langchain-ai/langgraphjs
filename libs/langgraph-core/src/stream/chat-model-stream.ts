/**
 * ChatModelStream implementation — one instance per AI message lifecycle.
 *
 * Created by the MessagesReducer when a `message-start` event is observed.
 * Tracks all content-block events and resolves projections (`.text`,
 * `.reasoning`, `.usage`) when `message-finish` arrives.
 */

import { AIMessage } from "@langchain/core/messages";
import type { ContentBlock, UsageMetadata } from "@langchain/core/messages";
import { EventLog } from "./event-log.js";
import type {
  ChatModelStream,
  MessagesEventData,
  Namespace,
  UsageInfo,
} from "./types.js";

function toCoreUsage(usage: UsageInfo | undefined): UsageMetadata | undefined {
  if (!usage) return undefined;
  return {
    ...usage,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  };
}

function applyContentDelta(
  target: ContentBlock,
  delta: ContentBlock
): ContentBlock {
  if (target.type !== delta.type) {
    return structuredClone(delta);
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
      return { ...target, ...delta } as ContentBlock;
  }
}

/**
 * Concrete implementation of the {@link ChatModelStream} interface.
 *
 * Each instance tracks a single AI message from `message-start` through
 * `message-finish`. Content-block deltas are accumulated into text and
 * reasoning projections that are available both as async iterables (for
 * streaming consumption) and as promise-like values (for awaiting the
 * final concatenated result).
 *
 * Instances are created by the `MessagesReducer` and should not be
 * constructed directly by application code.
 */
export class ChatModelStreamImpl implements ChatModelStream {
  /**
   * Hierarchical namespace identifying the position in the agent tree
   * that produced this message.
   */
  readonly namespace: Namespace;

  /**
   * The graph node that produced this message, if known.
   */
  readonly node: string | undefined;

  readonly #events = new EventLog<MessagesEventData>();
  readonly #textDeltas = new EventLog<string>();
  readonly #reasoningDeltas = new EventLog<string>();
  readonly #contentBlocks: Array<ContentBlock | undefined> = [];

  #messageId: string | undefined;
  #accumulatedText = "";
  #accumulatedReasoning = "";
  #responseMetadata: Record<string, unknown> = {};
  #finishReason: string | undefined;
  #resolveText: ((v: string) => void) | undefined;
  #resolveReasoning: ((v: string) => void) | undefined;
  #resolveUsage: ((v: UsageInfo | undefined) => void) | undefined;
  #resolveOutput: ((v: AIMessage) => void) | undefined;
  #rejectText: ((e: unknown) => void) | undefined;
  #rejectReasoning: ((e: unknown) => void) | undefined;
  #rejectUsage: ((e: unknown) => void) | undefined;
  #rejectOutput: ((e: unknown) => void) | undefined;

  readonly #textDone: Promise<string>;
  readonly #reasoningDone: Promise<string>;
  readonly #usageDone: Promise<UsageInfo | undefined>;
  readonly #outputDone: Promise<AIMessage>;

  /**
   * @param namespace - Hierarchical path identifying where in the agent
   *   tree this message originates.
   * @param node - The graph node name that produced this message, or
   *   `undefined` if not known.
   */
  constructor(namespace: Namespace, node: string | undefined) {
    this.namespace = namespace;
    this.node = node;

    this.#textDone = new Promise<string>((resolve, reject) => {
      this.#resolveText = resolve;
      this.#rejectText = reject;
    });
    this.#reasoningDone = new Promise<string>((resolve, reject) => {
      this.#resolveReasoning = resolve;
      this.#rejectReasoning = reject;
    });
    this.#usageDone = new Promise<UsageInfo | undefined>((resolve, reject) => {
      this.#resolveUsage = resolve;
      this.#rejectUsage = reject;
    });
    this.#outputDone = new Promise<AIMessage>((resolve, reject) => {
      this.#resolveOutput = resolve;
      this.#rejectOutput = reject;
    });
    // The stream may fail before callers ask for `.output`; attach a passive
    // handler so an intentionally unobserved output promise does not surface as
    // an unhandled rejection.
    void this.#outputDone.catch(() => undefined);
  }

  /**
   * Push a messages event into this stream.
   *
   * Called by the `MessagesReducer` for every event in this message's
   * lifecycle. Text and reasoning content-block deltas are accumulated
   * into the respective projections.
   *
   * @param data - The messages-channel event data to record.
   */
  pushEvent(data: MessagesEventData): void {
    this.#events.push(data);

    if (data.event === "message-start") {
      this.#messageId = data.id ?? this.#messageId;
    }

    if (data.event === "content-block-start") {
      this.#contentBlocks[data.index] = data.content as unknown as ContentBlock;
    }

    if (data.event === "content-block-delta") {
      const cb = data.content as Record<string, unknown>;
      const current = this.#contentBlocks[data.index];
      this.#contentBlocks[data.index] = current
        ? applyContentDelta(current, data.content as unknown as ContentBlock)
        : (data.content as unknown as ContentBlock);

      if (cb.type === "text" && typeof cb.text === "string") {
        this.#accumulatedText += cb.text;
        this.#textDeltas.push(cb.text);
      } else if (cb.type === "reasoning" && typeof cb.reasoning === "string") {
        this.#accumulatedReasoning += cb.reasoning;
        this.#reasoningDeltas.push(cb.reasoning);
      }
    }

    if (data.event === "content-block-finish") {
      this.#contentBlocks[data.index] = data.content as unknown as ContentBlock;
    }
  }

  /**
   * Finalize this stream with a `message-finish` event.
   *
   * Closes all internal event logs and resolves the text, reasoning, and
   * usage promises with their final values.
   *
   * @param data - The `message-finish` event data, which includes usage
   *   metadata and the finish reason.
   */
  finish(data: MessagesEventData & { event: "message-finish" }): void {
    this.#events.push(data);
    this.#events.close();
    this.#textDeltas.close();
    this.#reasoningDeltas.close();
    this.#resolveText?.(this.#accumulatedText);
    this.#resolveReasoning?.(this.#accumulatedReasoning);
    this.#resolveUsage?.(data.usage);
    this.#finishReason = data.reason;
    if (data.metadata) {
      this.#responseMetadata = {
        ...this.#responseMetadata,
        ...data.metadata,
      };
    }
    this.#resolveOutput?.(this.#assembleMessage(toCoreUsage(data.usage)));
  }

  /**
   * Abort this stream due to an error.
   *
   * Called when the run errors before a `message-finish` event is
   * received. Propagates the error to all internal event logs and
   * rejects all pending promises.
   *
   * @param err - The error to propagate to consumers.
   */
  fail(err: unknown): void {
    this.#events.fail(err);
    this.#textDeltas.fail(err);
    this.#reasoningDeltas.fail(err);
    this.#rejectText?.(err);
    this.#rejectReasoning?.(err);
    this.#rejectUsage?.(err);
    this.#rejectOutput?.(err);
  }

  /**
   * Returns an async iterator over all raw {@link MessagesEventData}
   * events in this message's lifecycle.
   *
   * @returns An async iterator that yields each event in order.
   */
  [Symbol.asyncIterator](): AsyncIterator<MessagesEventData> {
    return this.#events.iterate();
  }

  /**
   * Streaming text projection.
   *
   * When used as an `AsyncIterable`, yields individual text deltas as
   * they arrive. When used as a `PromiseLike`, resolves with the full
   * concatenated text after the message finishes.
   *
   * @returns A hybrid object that is both async-iterable and thenable.
   */
  get text(): AsyncIterable<string> & PromiseLike<string> {
    const iterable = this.#textDeltas.toAsyncIterable();
    const done = this.#textDone;
    return {
      [Symbol.asyncIterator]: () => iterable[Symbol.asyncIterator](),
      then: done.then.bind(done),
    };
  }

  /**
   * Streaming reasoning projection.
   *
   * When used as an `AsyncIterable`, yields individual reasoning deltas
   * as they arrive. When used as a `PromiseLike`, resolves with the
   * full concatenated reasoning text after the message finishes.
   *
   * @returns A hybrid object that is both async-iterable and thenable.
   */
  get reasoning(): AsyncIterable<string> & PromiseLike<string> {
    const iterable = this.#reasoningDeltas.toAsyncIterable();
    const done = this.#reasoningDone;
    return {
      [Symbol.asyncIterator]: () => iterable[Symbol.asyncIterator](),
      then: done.then.bind(done),
    };
  }

  /**
   * Usage metadata promise.
   *
   * Resolves with {@link UsageInfo} (or `undefined`) once the
   * `message-finish` event has been processed.
   *
   * @returns A promise-like that resolves with usage information.
   */
  get usage(): PromiseLike<UsageInfo | undefined> {
    return this.#usageDone;
  }

  get output(): PromiseLike<AIMessage> {
    return this.#outputDone;
  }

  then<TResult1 = AIMessage, TResult2 = never>(
    onfulfilled?:
      | ((value: AIMessage) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.#outputDone.then(onfulfilled, onrejected);
  }

  #assembleMessage(usage: UsageMetadata | undefined): AIMessage {
    return new AIMessage({
      id: this.#messageId,
      content: this.#contentBlocks.filter(
        (block): block is ContentBlock => block != null
      ),
      usage_metadata: usage,
      response_metadata: {
        ...this.#responseMetadata,
        ...(this.#finishReason ? { finish_reason: this.#finishReason } : {}),
        output_version: "v1" as const,
      },
    });
  }
}
