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
  SyntheticSubagentState,
} from "./internal-types.mjs";
import { isRecord } from "./internal-types.mjs";
import {
  extractTextContent,
  safeStringify,
} from "./event-normalizers.mjs";
import {
  toProtocolMessageMetadata,
  toProtocolMessageNamespace,
} from "./metadata.mjs";
import {
  createEmptyMessageState,
  getTupleFinishData,
} from "./state-normalizers.mjs";
import {
  finalizeTupleToolCall,
  getTupleToolCallIdentity,
  getTupleToolCallIndex,
} from "./tool-calls.mjs";

/**
 * Owns message-specific normalization, buffering, and synthetic subagent
 * emission for a run protocol session.
 */
export class SessionMessageProcessor {
  private readonly callbacks: MessageProcessorCallbacks;

  private readonly messageState = new Map<string, MessageState>();

  private readonly syntheticSubagents = new Map<string, SyntheticSubagentState>();

  /**
   * Creates a message processor bound to session callbacks.
   *
   * @param callbacks - Session hooks used to emit normalized protocol events.
   */
  constructor(callbacks: MessageProcessorCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Parses tool call arguments into an object suitable for synthetic subagents.
   *
   * @param args - Raw tool call arguments.
   * @returns Parsed object arguments, or an empty object when parsing fails.
   */
  private parseToolCallArgs(args: unknown): Record<string, unknown> {
    if (isRecord(args)) return args;
    if (typeof args === "string") {
      try {
        const parsed = JSON.parse(args);
        return isRecord(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }
    return {};
  }

  /**
   * Emits synthetic subagent events derived from task tool calls.
   *
   * @param namespace - Namespace associated with the incoming values payload.
   * @param values - Raw values payload to inspect.
   */
  async emitSyntheticSubagentEvents(
    namespace: Namespace,
    values: unknown
  ): Promise<void> {
    if (
      namespace.length > 0 ||
      !isRecord(values) ||
      !Array.isArray(values.messages)
    ) {
      return;
    }

    for (const rawMessage of values.messages) {
      if (!isRecord(rawMessage)) continue;

      if (rawMessage.type === "ai" && Array.isArray(rawMessage.tool_calls)) {
        for (const rawToolCall of rawMessage.tool_calls) {
          if (!isRecord(rawToolCall)) continue;
          if (rawToolCall.name !== "task" || typeof rawToolCall.id !== "string") {
            continue;
          }

          const toolCallId = rawToolCall.id;
          const toolNamespace = [`tools:${toolCallId}`] satisfies Namespace;
          const parsedArgs = this.parseToolCallArgs(rawToolCall.args);
          const description =
            typeof parsedArgs.description === "string"
              ? parsedArgs.description
              : "Task delegated to subagent.";

          if (this.syntheticSubagents.has(toolCallId)) {
            continue;
          }

          await this.callbacks.ensureNamespaces(toolNamespace);
          const humanMessage = {
            id: `subagent:${toolCallId}:human`,
            type: "human",
            content: description,
            additional_kwargs: {},
            response_metadata: {},
          };
          const syntheticState: SyntheticSubagentState = {
            namespace: toolNamespace,
            messages: [humanMessage],
            completed: false,
          };
          this.syntheticSubagents.set(toolCallId, syntheticState);

          await this.emitSyntheticTextMessage(
            toolNamespace,
            humanMessage.id,
            description
          );
          await this.callbacks.pushEvent(
            this.callbacks.createValuesEvent(toolNamespace, {
              messages: syntheticState.messages,
            })
          );
        }
      }

      if (
        rawMessage.type === "tool" &&
        typeof rawMessage.tool_call_id === "string" &&
        rawMessage.name === "task"
      ) {
        const syntheticState = this.syntheticSubagents.get(
          rawMessage.tool_call_id
        );
        if (syntheticState == null || syntheticState.completed) {
          continue;
        }

        const aiMessage = {
          id:
            typeof rawMessage.id === "string"
              ? `subagent:${rawMessage.id}`
              : `subagent:${rawMessage.tool_call_id}:ai`,
          type: "ai",
          content:
            typeof rawMessage.content === "string"
              ? rawMessage.content
              : safeStringify(rawMessage.content),
          additional_kwargs: {},
          response_metadata: {},
        };

        syntheticState.messages.push(aiMessage);
        syntheticState.completed = true;

        await this.emitSyntheticTextMessage(
          syntheticState.namespace,
          aiMessage.id,
          aiMessage.content as string
        );
        await this.callbacks.pushEvent(
          this.callbacks.createValuesEvent(syntheticState.namespace, {
            messages: syntheticState.messages,
          })
        );
        await this.callbacks.emitLifecycleEvent(
          syntheticState.namespace,
          rawMessage.status === "error" ? "failed" : "completed"
        );
      }
    }
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
      const text = extractTextContent(rawMessage.content);
      const state =
        this.messageState.get(messageId) ?? createEmptyMessageState();
      const messageNamespace =
        namespace.length > 0 ? namespace : (state.namespace ?? []);

      if (messageNamespace.length > 0) {
        await this.callbacks.ensureNamespaces(messageNamespace);
      }

      if (!state.started) {
        await this.callbacks.pushEvent(
          this.callbacks.createMessagesEvent(messageNamespace, {
            event: "message-start",
            messageId,
            ...(state.metadata != null ? { metadata: state.metadata } : {}),
          } satisfies MessageStartData)
        );
        await this.callbacks.pushEvent(
          this.callbacks.createMessagesEvent(messageNamespace, {
            event: "content-block-start",
            index: 0,
            contentBlock: { type: "text", text: "" },
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
              contentBlock: { type: "text", text: delta },
            } satisfies ContentBlockDeltaData)
          );
        }
        state.lastText = text;
      }

      if (method === "messages/complete" && !state.finished) {
        await this.callbacks.pushEvent(
          this.callbacks.createMessagesEvent(messageNamespace, {
            event: "content-block-finish",
            index: 0,
            contentBlock: { type: "text", text: state.lastText },
          } satisfies ContentBlockFinishData)
        );
        await this.callbacks.pushEvent(
          this.callbacks.createMessagesEvent(messageNamespace, {
            event: "message-finish",
            reason: "stop",
          } satisfies MessageFinishData)
        );
        state.finished = true;
      }

      this.messageState.set(messageId, state);
    }
  }

  /**
   * Emits a complete text message for a synthetic subagent namespace.
   *
   * @param namespace - Namespace that should receive the synthetic message.
   * @param messageId - Synthetic message identifier.
   * @param content - Full text content to emit.
   */
  private async emitSyntheticTextMessage(
    namespace: Namespace,
    messageId: string,
    content: string
  ) {
    if (namespace.length > 0) {
      await this.callbacks.ensureNamespaces(namespace);
    }

    await this.callbacks.pushEvent(
      this.callbacks.createMessagesEvent(namespace, {
        event: "message-start",
        messageId,
      } satisfies MessageStartData)
    );
    await this.callbacks.pushEvent(
      this.callbacks.createMessagesEvent(namespace, {
        event: "content-block-start",
        index: 0,
        contentBlock: { type: "text", text: "" },
      } satisfies ContentBlockStartData)
    );
    if (content.length > 0) {
      await this.callbacks.pushEvent(
        this.callbacks.createMessagesEvent(namespace, {
          event: "content-block-delta",
          index: 0,
          contentBlock: { type: "text", text: content },
        } satisfies ContentBlockDeltaData)
      );
    }
    await this.callbacks.pushEvent(
      this.callbacks.createMessagesEvent(namespace, {
        event: "content-block-finish",
        index: 0,
        contentBlock: { type: "text", text: content },
      } satisfies ContentBlockFinishData)
    );
    await this.callbacks.pushEvent(
      this.callbacks.createMessagesEvent(namespace, {
        event: "message-finish",
        reason: "stop",
      } satisfies MessageFinishData)
    );
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
    messageId: string,
    state: MessageState
  ) {
    if (state.started) return;

    await this.callbacks.pushEvent(
      this.callbacks.createMessagesEvent(namespace, {
        event: "message-start",
        messageId,
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
          contentBlock:
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
        contentBlock:
          type === "text"
            ? { type: "text", text: value }
            : { type: "reasoning", reasoning: value },
      } satisfies ContentBlockDeltaData)
    );
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
          contentBlock: {
            type: "tool_call_chunk",
            ...(options?.id != null ? { id: options.id } : {}),
            ...(options?.name != null ? { name: options.name } : {}),
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
        contentBlock: {
          type: "tool_call_chunk",
          ...(options?.id != null ? { id: options.id } : {}),
          ...(options?.name != null ? { name: options.name } : {}),
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
    finishData: Pick<MessageFinishData, "reason"> &
      Partial<Pick<MessageFinishData, "usage" | "metadata">>
  ) {
    const blocks = [...state.blocks.entries()].sort(
      ([left], [right]) => left - right
    );

    for (const [index, block] of blocks) {
      if (block.finished) continue;

      let contentBlock: ContentBlockFinishData["contentBlock"];
      if (block.type === "text") {
        contentBlock = { type: "text", text: block.value };
      } else if (block.type === "reasoning") {
        contentBlock = { type: "reasoning", reasoning: block.value };
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
          contentBlock,
        } satisfies ContentBlockFinishData)
      );
      block.finished = true;
    }

    await this.callbacks.pushEvent(
      this.callbacks.createMessagesEvent(namespace, {
        event: "message-finish",
        reason: finishData.reason,
        ...(finishData.usage != null ? { usage: finishData.usage } : {}),
        ...(finishData.metadata != null ? { metadata: finishData.metadata } : {}),
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
    const resolvedNamespace =
      namespace.length > 0
        ? namespace
        : toProtocolMessageNamespace(metadata) ?? state.namespace ?? [];
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
      serialized.id,
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
    } else if (Array.isArray(serialized.content)) {
      for (let offset = 0; offset < serialized.content.length; offset += 1) {
        const block = serialized.content[offset];
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
