import type { MessageRole } from "@langchain/protocol";
import type {
  ContentBlockDeltaData,
  ContentBlockFinishData,
  ContentBlockStartData,
  MessageFinishData,
  MessageStartData,
  Namespace,
} from "../types.mjs";
import type {
  MessageProcessorCallbacks,
  MessageState,
} from "./internal-types.mjs";
import { isRecord } from "./internal-types.mjs";
import { extractTextContent } from "./event-normalizers.mjs";
import {
  toProtocolMessageMetadata,
  toProtocolMessageNamespace,
} from "./metadata.mjs";
import {
  createEmptyMessageState,
  getTupleFinishData,
  normalizeProtocolFinalizedContentBlock,
  normalizeProtocolMessageContent,
} from "./state-normalizers.mjs";
import {
  finalizeTupleToolCall,
  getTupleToolCallIdentity,
  getTupleToolCallIndex,
} from "./tool-calls.mjs";

/**
 * Owns message-specific normalization and buffering for a run
 * protocol session.
 *
 * Synthetic subagent emission and task-tool namespace remapping used
 * to live here — both have moved into product-specific stream
 * transformers (see `deepagents`'s `createSubagentTransformer`) so
 * this class stays product-agnostic and only handles legacy message
 * normalization.
 */
export class SessionMessageProcessor {
  private readonly callbacks: MessageProcessorCallbacks;

  private readonly messageState = new Map<string, MessageState>();

  /**
   * Creates a message processor bound to session callbacks.
   *
   * @param callbacks - Session hooks used to emit normalized protocol events.
   */
  constructor(callbacks: MessageProcessorCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Normalizes legacy message stream variants into protocol message events.
   *
   * @param method - Legacy message stream method name.
   * @param namespace - Namespace associated with the event.
   * @param data - Raw legacy message payload.
   */
  async normalizeLegacyMessageEvent(
    method: string,
    namespace: Namespace,
    data: unknown
  ) {
    if (method === "messages/metadata") {
      if (!isRecord(data)) return;
      for (const [messageId, value] of Object.entries(data)) {
        const state =
          this.messageState.get(messageId) ?? createEmptyMessageState();
        state.metadata = toProtocolMessageMetadata(value);
        state.namespace = toProtocolMessageNamespace(value) ?? state.namespace;
        this.messageState.set(messageId, state);
      }
      return;
    }

    if (!Array.isArray(data)) return;

    for (const rawMessage of data) {
      if (!isRecord(rawMessage) || typeof rawMessage.id !== "string") continue;

      const messageId = rawMessage.id;
      const normalizedContent = normalizeProtocolMessageContent(
        rawMessage.content,
        {
          additionalKwargs: isRecord(rawMessage.additional_kwargs)
            ? rawMessage.additional_kwargs
            : undefined,
        }
      );
      const text = extractTextContent(normalizedContent) ?? "";
      const state =
        this.messageState.get(messageId) ?? createEmptyMessageState();
      const candidateNamespace =
        namespace.length > 0 ? namespace : (state.namespace ?? []);
      const messageNamespace =
        candidateNamespace.length > 0
          ? candidateNamespace
          : (state.namespace ?? []);

      if (messageNamespace.length > 0) {
        await this.callbacks.ensureNamespaces(messageNamespace);
      }

      if (!state.started) {
        await this.callbacks.pushEvent(
          this.callbacks.createMessagesEvent(messageNamespace, {
            event: "message-start",
            role: rawMessage.type as MessageRole,
            id: messageId,
            ...(state.metadata != null ? { metadata: state.metadata } : {}),
          } satisfies MessageStartData)
        );
        await this.callbacks.pushEvent(
          this.callbacks.createMessagesEvent(messageNamespace, {
            event: "content-block-start",
            index: 0,
            content: { type: "text", text: "" },
          } satisfies ContentBlockStartData)
        );
        state.started = true;
      }

      const previousText = state.lastText;
      if (typeof text === "string" && text.length >= previousText.length) {
        const delta = text.slice(previousText.length);
        if (delta.length > 0) {
          await this.callbacks.pushEvent(
            this.callbacks.createMessagesEvent(messageNamespace, {
              event: "content-block-delta",
              index: 0,
              content: { type: "text", text: delta },
            } satisfies ContentBlockDeltaData)
          );
        }
        state.lastText = text;
      }

      if (Array.isArray(normalizedContent)) {
        for (let offset = 0; offset < normalizedContent.length; offset += 1) {
          const block = normalizedContent[offset];
          if (!isRecord(block)) continue;
          const index = typeof block.index === "number" ? block.index : offset;
          if (block.type === "text" || block.type === "reasoning") {
            continue;
          }
          const normalizedBlock = normalizeProtocolFinalizedContentBlock(block);
          if (normalizedBlock == null) {
            continue;
          }
          await this.emitTupleFinalizedBlock(
            messageNamespace,
            state,
            index,
            normalizedBlock
          );
        }
      }

      if (method === "messages/complete" && !state.finished) {
        await this.callbacks.pushEvent(
          this.callbacks.createMessagesEvent(messageNamespace, {
            event: "content-block-finish",
            index: 0,
            content: { type: "text", text: state.lastText },
          } satisfies ContentBlockFinishData)
        );
        await this.callbacks.pushEvent(
          this.callbacks.createMessagesEvent(messageNamespace, {
            event: "message-finish",
          } satisfies MessageFinishData)
        );
        state.finished = true;
      }

      this.messageState.set(messageId, state);
    }
  }

  /**
   * Ensures that a tuple message emits its start event exactly once.
   *
   * @param namespace - Namespace receiving the tuple message.
   * @param messageId - Message identifier.
   * @param state - Mutable message accumulator.
   */
  private async ensureTupleMessageStarted(
    namespace: Namespace,
    message: { id: string; type: MessageRole },
    state: MessageState
  ) {
    const { id, type } = message;
    if (state.started) return;

    await this.callbacks.pushEvent(
      this.callbacks.createMessagesEvent(namespace, {
        event: "message-start",
        role: type,
        id: id,
        ...(state.metadata != null ? { metadata: state.metadata } : {}),
      } satisfies MessageStartData)
    );
    state.started = true;
  }

  /**
   * Emits text or reasoning deltas for a tuple message block.
   *
   * @param namespace - Namespace receiving the block.
   * @param state - Mutable message accumulator.
   * @param index - Content block index.
   * @param type - Block type to emit.
   * @param value - Incremental block text.
   */
  private async emitTupleTextLikeDelta(
    namespace: Namespace,
    state: MessageState,
    index: number,
    type: "text" | "reasoning",
    value: string
  ) {
    if (value.length === 0) return;

    const existing = state.blocks.get(index);
    if (existing == null) {
      await this.callbacks.pushEvent(
        this.callbacks.createMessagesEvent(namespace, {
          event: "content-block-start",
          index,
          content:
            type === "text"
              ? { type: "text", text: "" }
              : { type: "reasoning", reasoning: "" },
        } satisfies ContentBlockStartData)
      );
      state.blocks.set(index, {
        type,
        value,
        finished: false,
      });
    } else {
      if (existing.type !== type) return;
      existing.value += value;
    }

    await this.callbacks.pushEvent(
      this.callbacks.createMessagesEvent(namespace, {
        event: "content-block-delta",
        index,
        content:
          type === "text"
            ? { type: "text", text: value }
            : { type: "reasoning", reasoning: value },
      } satisfies ContentBlockDeltaData)
    );
  }

  /**
   * Emits a finalized non-text content block that does not stream via deltas.
   *
   * @param namespace - Namespace receiving the block.
   * @param state - Mutable message accumulator.
   * @param index - Content block index.
   * @param contentBlock - Finalized protocol content block.
   */
  private async emitTupleFinalizedBlock(
    namespace: Namespace,
    state: MessageState,
    index: number,
    contentBlock: ContentBlockFinishData["content"]
  ) {
    const existing = state.blocks.get(index);
    if (existing != null) return;

    await this.callbacks.pushEvent(
      this.callbacks.createMessagesEvent(namespace, {
        event: "content-block-start",
        index,
        content: contentBlock,
      } satisfies ContentBlockStartData)
    );
    await this.callbacks.pushEvent(
      this.callbacks.createMessagesEvent(namespace, {
        event: "content-block-finish",
        index,
        content: contentBlock,
      } satisfies ContentBlockFinishData)
    );
    state.blocks.set(index, {
      type: "finalized",
      value: "",
      finished: true,
      contentBlock,
    });
  }

  /**
   * Emits incremental tool call chunks for a tuple message block.
   *
   * @param namespace - Namespace receiving the block.
   * @param state - Mutable message accumulator.
   * @param index - Content block index.
   * @param value - Incremental tool call args chunk.
   * @param options - Optional tool call identity metadata.
   */
  private async emitTupleToolCallDelta(
    namespace: Namespace,
    state: MessageState,
    index: number,
    value: string,
    options?: { id?: string; name?: string }
  ) {
    const existing = state.blocks.get(index);
    if (existing == null) {
      await this.callbacks.pushEvent(
        this.callbacks.createMessagesEvent(namespace, {
          event: "content-block-start",
          index,
          content: {
            type: "tool_call_chunk",
            id: options?.id ?? null,
            name: options?.name ?? null,
            args: "",
          },
        } satisfies ContentBlockStartData)
      );
      state.blocks.set(index, {
        type: "tool_call_chunk",
        value,
        finished: false,
        id: options?.id,
        name: options?.name,
      });
    } else {
      if (existing.type !== "tool_call_chunk") return;
      existing.value += value;
      existing.id ??= options?.id;
      existing.name ??= options?.name;
    }

    if (value.length === 0) return;

    await this.callbacks.pushEvent(
      this.callbacks.createMessagesEvent(namespace, {
        event: "content-block-delta",
        index,
        content: {
          type: "tool_call_chunk",
          id: options?.id ?? null,
          name: options?.name ?? null,
          args: value,
        },
      } satisfies ContentBlockDeltaData)
    );
  }

  /**
   * Finalizes all open blocks for a tuple message and emits the finish event.
   *
   * @param namespace - Namespace receiving the terminal events.
   * @param serialized - Serialized message payload.
   * @param state - Mutable message accumulator.
   * @param finishData - Final message metadata to emit.
   */
  private async finishTupleMessage(
    namespace: Namespace,
    serialized: Record<string, unknown>,
    state: MessageState,
    finishData: Partial<Pick<MessageFinishData, "usage" | "metadata">>
  ) {
    const blocks = [...state.blocks.entries()].sort(
      ([left], [right]) => left - right
    );

    for (const [index, block] of blocks) {
      if (block.finished) continue;

      let contentBlock: ContentBlockFinishData["content"];
      if (block.type === "text") {
        contentBlock = { type: "text", text: block.value };
      } else if (block.type === "reasoning") {
        contentBlock = { type: "reasoning", reasoning: block.value };
      } else if (block.type === "finalized" && block.contentBlock != null) {
        contentBlock = block.contentBlock;
      } else {
        contentBlock = finalizeTupleToolCall(
          block,
          serialized.tool_calls,
          serialized.invalid_tool_calls,
          index
        );
      }

      await this.callbacks.pushEvent(
        this.callbacks.createMessagesEvent(namespace, {
          event: "content-block-finish",
          index,
          content: contentBlock,
        } satisfies ContentBlockFinishData)
      );
      block.finished = true;
    }

    await this.callbacks.pushEvent(
      this.callbacks.createMessagesEvent(namespace, {
        event: "message-finish",
        ...(finishData.usage != null ? { usage: finishData.usage } : {}),
        ...(finishData.metadata != null
          ? { metadata: finishData.metadata }
          : {}),
      } satisfies MessageFinishData)
    );
    state.finished = true;
  }

  /**
   * Normalizes tuple-based message stream payloads into protocol events.
   *
   * @param namespace - Namespace associated with the event.
   * @param serialized - Serialized message payload.
   * @param metadata - Companion message metadata from the source stream.
   */
  async normalizeTupleMessageEvent(
    namespace: Namespace,
    serialized: Record<string, unknown>,
    metadata: unknown
  ) {
    if (typeof serialized.id !== "string") return;

    const state =
      this.messageState.get(serialized.id) ?? createEmptyMessageState();
    const normalizedContent = normalizeProtocolMessageContent(
      serialized.content
    );
    const resolvedNamespace =
      namespace.length > 0
        ? namespace
        : (toProtocolMessageNamespace(metadata) ?? state.namespace ?? []);
    const conciseMetadata = toProtocolMessageMetadata(metadata);

    if (conciseMetadata != null) {
      state.metadata = conciseMetadata;
    }
    state.namespace = resolvedNamespace;

    if (resolvedNamespace.length > 0) {
      await this.callbacks.ensureNamespaces(resolvedNamespace);
    }

    await this.ensureTupleMessageStarted(
      resolvedNamespace,
      { id: serialized.id, type: serialized.type as MessageRole },
      state
    );

    if (typeof serialized.content === "string") {
      await this.emitTupleTextLikeDelta(
        resolvedNamespace,
        state,
        0,
        "text",
        serialized.content
      );
    } else if (Array.isArray(normalizedContent)) {
      for (let offset = 0; offset < normalizedContent.length; offset += 1) {
        const block = normalizedContent[offset];
        if (!isRecord(block)) continue;
        const index = typeof block.index === "number" ? block.index : offset;
        if (block.type === "text" && typeof block.text === "string") {
          await this.emitTupleTextLikeDelta(
            resolvedNamespace,
            state,
            index,
            "text",
            block.text
          );
        } else if (
          block.type === "reasoning" &&
          typeof block.reasoning === "string"
        ) {
          await this.emitTupleTextLikeDelta(
            resolvedNamespace,
            state,
            index,
            "reasoning",
            block.reasoning
          );
        } else {
          const normalizedBlock = normalizeProtocolFinalizedContentBlock(block);
          if (normalizedBlock == null) {
            continue;
          }
          await this.emitTupleFinalizedBlock(
            resolvedNamespace,
            state,
            index,
            normalizedBlock
          );
        }
      }
    }

    if (Array.isArray(serialized.tool_call_chunks)) {
      for (
        let offset = 0;
        offset < serialized.tool_call_chunks.length;
        offset += 1
      ) {
        const rawToolCallChunk = serialized.tool_call_chunks[offset];
        if (!isRecord(rawToolCallChunk)) continue;

        const index = getTupleToolCallIndex(rawToolCallChunk, offset);
        const identity = getTupleToolCallIdentity(rawToolCallChunk);
        await this.emitTupleToolCallDelta(
          resolvedNamespace,
          state,
          index,
          typeof rawToolCallChunk.args === "string"
            ? rawToolCallChunk.args
            : "",
          identity
        );
      }
    }

    const finishData = getTupleFinishData(serialized);
    if (finishData != null && !state.finished) {
      await this.finishTupleMessage(
        resolvedNamespace,
        serialized,
        state,
        finishData
      );
    }

    this.messageState.set(serialized.id, state);
  }
}
