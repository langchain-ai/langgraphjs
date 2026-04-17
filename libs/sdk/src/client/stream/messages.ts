import type {
  ContentBlock,
  FinalizedContentBlock,
  MessageMetadata,
  MessageFinishData,
  MessagesEvent,
  UsageInfo,
} from "@langchain/protocol";

/**
 * Mutable view of a streamed message as message and content-block events are
 * assembled into a single structure.
 */
export interface AssembledMessage {
  namespace: string[];
  node?: string;
  messageId?: string;
  metadata?: MessageMetadata;
  blocks: ContentBlock[];
  usage?: UsageInfo;
  finishReason?: MessageFinishData["reason"];
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
export class StreamingMessage {
  readonly namespace: string[];
  readonly node: string | undefined;
  readonly messageId: string | undefined;
  readonly metadata: MessageMetadata | undefined;
  readonly assembled: AssembledMessage;

  #textChunks: string[] = [];
  #reasoningChunks: string[] = [];
  #textWaiters: Array<(value: IteratorResult<string>) => void> = [];
  #reasoningWaiters: Array<(value: IteratorResult<string>) => void> = [];
  #textDone = false;
  #reasoningDone = false;

  #resolveText!: (v: string) => void;
  #resolveReasoning!: (v: string) => void;
  #resolveUsage!: (v: UsageInfo | undefined) => void;
  readonly #textPromise: Promise<string>;
  readonly #reasoningPromise: Promise<string>;
  readonly #usagePromise: Promise<UsageInfo | undefined>;

  constructor(assembled: AssembledMessage) {
    this.assembled = assembled;
    this.namespace = assembled.namespace;
    this.node = assembled.node;
    this.messageId = assembled.messageId;
    this.metadata = assembled.metadata;
    this.#textPromise = new Promise<string>((r) => {
      this.#resolveText = r;
    });
    this.#reasoningPromise = new Promise<string>((r) => {
      this.#resolveReasoning = r;
    });
    this.#usagePromise = new Promise<UsageInfo | undefined>((r) => {
      this.#resolveUsage = r;
    });
  }

  get text(): AsyncIterable<string> & PromiseLike<string> {
    const chunks = this.#textChunks;
    const waiters = this.#textWaiters;
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this;
    let cursor = 0;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            if (cursor < chunks.length) {
              return { done: false, value: chunks[cursor++] };
            }
            if (self.#textDone) {
              return { done: true, value: undefined };
            }
            return await new Promise<IteratorResult<string>>((resolve) => {
              waiters.push(resolve);
            });
          },
        };
      },
      then: self.#textPromise.then.bind(self.#textPromise),
    };
  }

  get reasoning(): AsyncIterable<string> & PromiseLike<string> {
    const chunks = this.#reasoningChunks;
    const waiters = this.#reasoningWaiters;
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this;
    let cursor = 0;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            if (cursor < chunks.length) {
              return { done: false, value: chunks[cursor++] };
            }
            if (self.#reasoningDone) {
              return { done: true, value: undefined };
            }
            return await new Promise<IteratorResult<string>>((resolve) => {
              waiters.push(resolve);
            });
          },
        };
      },
      then: self.#reasoningPromise.then.bind(self.#reasoningPromise),
    };
  }

  get usage(): PromiseLike<UsageInfo | undefined> {
    return this.#usagePromise;
  }

  get blocks(): ContentBlock[] {
    return this.assembled.blocks;
  }

  [PUSH_TEXT](delta: string): void {
    this.#textChunks.push(delta);
    const waiter = this.#textWaiters.shift();
    if (waiter) waiter({ done: false, value: delta });
  }

  [PUSH_REASONING](delta: string): void {
    this.#reasoningChunks.push(delta);
    const waiter = this.#reasoningWaiters.shift();
    if (waiter) waiter({ done: false, value: delta });
  }

  [FINISH](usage: UsageInfo | undefined): void {
    this.#textDone = true;
    this.#reasoningDone = true;
    this.#resolveText(this.#textChunks.join(""));
    this.#resolveReasoning(this.#reasoningChunks.join(""));
    this.#resolveUsage(usage);
    while (this.#textWaiters.length > 0) {
      this.#textWaiters.shift()?.({ done: true, value: undefined });
    }
    while (this.#reasoningWaiters.length > 0) {
      this.#reasoningWaiters.shift()?.({ done: true, value: undefined });
    }
  }

  [ERROR](): void {
    this[FINISH](undefined);
  }
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
      };
    case "reasoning":
      return {
        ...target,
        ...delta,
        reasoning: `${"reasoning" in target ? target.reasoning : ""}${delta.reasoning}`,
      };
    case "tool_call_chunk":
    case "server_tool_call_chunk":
      return {
        ...target,
        ...delta,
        args: `${("args" in target ? target.args : "") ?? ""}${delta.args ?? ""}`,
      };
    default:
      return {
        ...target,
        ...delta,
      };
  }
}

function messageKeyFor(event: MessagesEvent): string {
  const { namespace, node, data } = event.params;
  const namespaceKey = namespace.join("/");
  const messageId =
    data.event === "message-start" ? (data.message_id ?? "") : "";
  return `${namespaceKey}::${node ?? ""}::${messageId}`;
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
        namespace: [...event.params.namespace],
        node: event.params.node,
        messageId: data.message_id,
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

    switch (data.event) {
      case "content-block-start": {
        message.blocks[data.index] = cloneBlock(data.content_block);
        return {
          kind: "content-block-start",
          key: activeKey,
          message,
          index: data.index,
          block: data.content_block,
          event,
        };
      }
      case "content-block-delta": {
        const current = ensureBlockIndex(
          message.blocks,
          data.index,
          data.content_block
        );
        message.blocks[data.index] = applyContentDelta(
          current,
          data.content_block
        );
        return {
          kind: "content-block-delta",
          key: activeKey,
          message,
          index: data.index,
          block: data.content_block,
          event,
        };
      }
      case "content-block-finish": {
        message.blocks[data.index] = cloneBlock(data.content_block);
        return {
          kind: "content-block-finish",
          key: activeKey,
          message,
          index: data.index,
          block: data.content_block,
          event,
        };
      }
      case "message-finish": {
        message.finishReason = data.reason;
        message.usage = data.usage;
        message.finishMetadata = data.metadata;
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

    switch (update.kind) {
      case "message-start": {
        const streaming = new StreamingMessage(update.message);
        this.#activeStreaming.set(update.key, streaming);
        return streaming;
      }
      case "content-block-start": {
        const streaming = this.#activeStreaming.get(update.key);
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
        if (update.block.type === "text" && "text" in update.block) {
          streaming[PUSH_TEXT](update.block.text);
        }
        if (update.block.type === "reasoning" && "reasoning" in update.block) {
          streaming[PUSH_REASONING](update.block.reasoning);
        }
        return undefined;
      }
      case "content-block-finish":
        return undefined;
      case "message-finish": {
        const streaming = this.#activeStreaming.get(update.key);
        if (streaming) {
          streaming[FINISH](update.message.usage);
          this.#activeStreaming.delete(update.key);
        }
        return undefined;
      }
      case "message-error": {
        const streaming = this.#activeStreaming.get(update.key);
        if (streaming) {
          streaming[ERROR]();
          this.#activeStreaming.delete(update.key);
        }
        return undefined;
      }
    }
  }
}
