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
  SyntheticSubagentState,
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

const getFirstToolSegment = (namespace: Namespace) =>
  namespace.find((segment) => segment.startsWith("tools:"));

const isPublicToolCallSegment = (segment: string | undefined) =>
  segment?.startsWith("tools:call_") ?? false;

type SyntheticSubagentRegistration = SyntheticSubagentState & {
  description: string;
  internalToolSegment?: string;
};

/**
 * Owns message-specific normalization, buffering, and synthetic subagent
 * emission for a run protocol session.
 */
export class SessionMessageProcessor {
  private readonly callbacks: MessageProcessorCallbacks;

  private readonly messageState = new Map<string, MessageState>();

  private readonly syntheticSubagents = new Map<
    string,
    SyntheticSubagentRegistration
  >();

  private readonly syntheticNamespaceAliases = new Map<string, string>();

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
          if (
            rawToolCall.name !== "task" ||
            typeof rawToolCall.id !== "string"
          ) {
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
          const syntheticState: SyntheticSubagentRegistration = {
            description,
            internalToolSegment: undefined,
            namespace: toolNamespace,
            messages: [humanMessage],
            completed: false,
          };
          this.syntheticSubagents.set(toolCallId, syntheticState);

          await this.emitSyntheticMessage(
            toolNamespace,
            { id: humanMessage.id, type: "human" },
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

        const artifactMessage = isRecord(rawMessage.artifact)
          ? rawMessage.artifact
          : undefined;
        const aiMessageContent = normalizeProtocolMessageContent(
          artifactMessage != null && "content" in artifactMessage
            ? artifactMessage.content
            : rawMessage.content,
          {
            additionalKwargs: isRecord(artifactMessage?.additional_kwargs)
              ? artifactMessage.additional_kwargs
              : undefined,
          }
        );

        const aiMessage = {
          id:
            typeof rawMessage.id === "string"
              ? `subagent:${rawMessage.id}`
              : `subagent:${rawMessage.tool_call_id}:ai`,
          type: "ai",
          content: aiMessageContent,
          additional_kwargs: {},
          response_metadata: {},
        };

        syntheticState.messages.push(aiMessage);
        syntheticState.completed = true;

        await this.emitSyntheticMessage(
          syntheticState.namespace,
          { id: aiMessage.id, type: "ai" },
          aiMessage.content
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
   * Applies any previously-seeded task-tool namespace aliases to the given
   * namespace. Safe to call on any incoming source namespace — returns the
   * namespace unchanged when no alias applies.
   */
  remapNamespaceForClient(namespace: Namespace): Namespace {
    return this.remapSyntheticNamespace(namespace);
  }

  /**
   * Seeds task-tool namespace aliases from a `tools` source event. When the
   * coordinator launches a subagent via the `task` tool, langgraph emits a
   * `tool-started` event on the INTERNAL `tools:<uuid>` namespace carrying
   * the public `tool_call_id` — exactly the mapping needed to bind the
   * internal namespace to `tools:call_<id>`. Seeding here is preferable to
   * description-matching against the first human values payload because the
   * tool-started event lands before the subagent's first v2 message event.
   */
  seedNamespaceAliasFromToolsEvent(namespace: Namespace, data: unknown): void {
    const toolSegment = getFirstToolSegment(namespace);
    if (toolSegment == null || isPublicToolCallSegment(toolSegment)) return;
    if (this.syntheticNamespaceAliases.has(toolSegment)) return;
    if (!isRecord(data)) return;
    // Accept both normalized (`tool-started` / `tool_name`) and raw
    // (`on_tool_start` / `name`) shapes; `handleSourceEvent` may dispatch
    // either form depending on whether upstream already normalized the event.
    const isStartEvent =
      data.event === "tool-started" || data.event === "on_tool_start";
    if (!isStartEvent) return;
    const toolName =
      typeof data.tool_name === "string"
        ? data.tool_name
        : typeof data.name === "string"
          ? data.name
          : undefined;
    if (toolName !== "task") return;
    const toolCallId =
      typeof data.tool_call_id === "string"
        ? data.tool_call_id
        : typeof data.id === "string"
          ? data.id
          : undefined;
    if (toolCallId == null) return;

    const syntheticState = this.syntheticSubagents.get(toolCallId);
    const publicToolSegment = `tools:${toolCallId}`;
    this.syntheticNamespaceAliases.set(toolSegment, publicToolSegment);
    if (syntheticState != null && syntheticState.internalToolSegment == null) {
      syntheticState.internalToolSegment = toolSegment;
    }
  }

  /**
   * Seeds task-tool namespace aliases from a values payload emitted on an
   * internal `tools:<uuid>` namespace. The subagent's initial prompt (from the
   * coordinator's `task` call) surfaces as the first human message in state;
   * matching its text to a pending synthetic task registration binds the
   * internal namespace to the public `tools:call_*` namespace so later v2
   * stream events land on the client-visible namespace.
   */
  seedNamespaceAliasFromValues(namespace: Namespace, values: unknown): void {
    const toolSegment = getFirstToolSegment(namespace);
    if (toolSegment == null || isPublicToolCallSegment(toolSegment)) return;
    if (this.syntheticNamespaceAliases.has(toolSegment)) return;
    if (!isRecord(values) || !Array.isArray(values.messages)) return;

    const firstHuman = values.messages.find(
      (message): message is Record<string, unknown> =>
        isRecord(message) && message.type === "human"
    );
    if (firstHuman == null) return;

    const normalizedContent = normalizeProtocolMessageContent(
      firstHuman.content,
      {
        additionalKwargs: isRecord(firstHuman.additional_kwargs)
          ? firstHuman.additional_kwargs
          : undefined,
      }
    );
    const text = extractTextContent(normalizedContent) ?? "";
    if (text.length === 0) return;

    for (const [toolCallId, syntheticState] of this.syntheticSubagents) {
      if (
        syntheticState.description !== text ||
        syntheticState.internalToolSegment != null
      ) {
        continue;
      }
      const publicToolSegment = `tools:${toolCallId}`;
      this.syntheticNamespaceAliases.set(toolSegment, publicToolSegment);
      syntheticState.internalToolSegment = toolSegment;
      return;
    }
  }

  private remapSyntheticNamespace(namespace: Namespace): Namespace {
    let replaced = false;
    const remapped = namespace.map((segment) => {
      if (replaced) return segment;
      const alias = this.syntheticNamespaceAliases.get(segment);
      if (alias == null) return segment;
      replaced = true;
      return alias;
    });
    return replaced ? remapped : namespace;
  }

  /**
   * Resolves whether an internal task-tool namespace should be aliased onto the
   * public task tool-call namespace.
   *
   * The first internal `human` prompt for a subgraph carries the same
   * description text as the root-level synthetic task registration. This
   * method uses that prompt to bind the internal `tools:<id>` namespace to the
   * public `tools:call_*` namespace, suppress the duplicate prompt emission,
   * and remap all later events onto the public namespace so clients observe a
   * single coherent delegated-task stream.
   *
   * @param namespace - Incoming namespace emitted by the underlying run stream.
   * @param messageType - Raw message type associated with the event.
   * @param text - Extracted text content used for description matching.
   * @returns The remapped namespace plus whether the current event should be skipped.
   */
  private resolveTaskToolNamespaceAlias(
    namespace: Namespace,
    messageType: unknown,
    text: string
  ): { namespace: Namespace; skipEmission: boolean } {
    const toolSegment = getFirstToolSegment(namespace);
    if (
      messageType !== "human" ||
      text.length === 0 ||
      toolSegment == null ||
      isPublicToolCallSegment(toolSegment)
    ) {
      return {
        namespace: this.remapSyntheticNamespace(namespace),
        skipEmission: false,
      };
    }

    const existingAlias = this.syntheticNamespaceAliases.get(toolSegment);
    if (existingAlias != null) {
      return {
        namespace: this.remapSyntheticNamespace(namespace),
        skipEmission: true,
      };
    }

    for (const [toolCallId, syntheticState] of this.syntheticSubagents) {
      if (
        syntheticState.description !== text ||
        syntheticState.internalToolSegment != null
      ) {
        continue;
      }

      const publicToolSegment = `tools:${toolCallId}`;
      this.syntheticNamespaceAliases.set(toolSegment, publicToolSegment);
      syntheticState.internalToolSegment = toolSegment;
      return {
        namespace: this.remapSyntheticNamespace(namespace),
        skipEmission: true,
      };
    }

    return {
      namespace: this.remapSyntheticNamespace(namespace),
      skipEmission: false,
    };
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
      const { namespace: aliasedNamespace, skipEmission } =
        this.resolveTaskToolNamespaceAlias(
          candidateNamespace,
          rawMessage.type,
          text
        );
      if (skipEmission) {
        continue;
      }
      const messageNamespace =
        aliasedNamespace.length > 0
          ? aliasedNamespace
          : (state.namespace ?? []);

      if (messageNamespace.length > 0) {
        await this.callbacks.ensureNamespaces(messageNamespace);
      }

      if (!state.started) {
        await this.callbacks.pushEvent(
          this.callbacks.createMessagesEvent(messageNamespace, {
            event: "message-start",
            role: rawMessage.type as MessageRole,
            message_id: messageId,
            ...(state.metadata != null ? { metadata: state.metadata } : {}),
          } satisfies MessageStartData)
        );
        await this.callbacks.pushEvent(
          this.callbacks.createMessagesEvent(messageNamespace, {
            event: "content-block-start",
            index: 0,
            content_block: { type: "text", text: "" },
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
              content_block: { type: "text", text: delta },
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
            content_block: { type: "text", text: state.lastText },
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
  private async emitSyntheticMessage(
    namespace: Namespace,
    message: { id: string; type: MessageRole },
    content: unknown
  ) {
    const { id, type } = message;
    if (namespace.length > 0) {
      await this.callbacks.ensureNamespaces(namespace);
    }

    await this.callbacks.pushEvent(
      this.callbacks.createMessagesEvent(namespace, {
        event: "message-start",
        role: type,
        message_id: id,
      } satisfies MessageStartData)
    );

    const normalizedContent = normalizeProtocolMessageContent(content);
    if (typeof normalizedContent === "string") {
      await this.callbacks.pushEvent(
        this.callbacks.createMessagesEvent(namespace, {
          event: "content-block-start",
          index: 0,
          content_block: { type: "text", text: "" },
        } satisfies ContentBlockStartData)
      );
      if (normalizedContent.length > 0) {
        await this.callbacks.pushEvent(
          this.callbacks.createMessagesEvent(namespace, {
            event: "content-block-delta",
            index: 0,
            content_block: { type: "text", text: normalizedContent },
          } satisfies ContentBlockDeltaData)
        );
      }
      await this.callbacks.pushEvent(
        this.callbacks.createMessagesEvent(namespace, {
          event: "content-block-finish",
          index: 0,
          content_block: { type: "text", text: normalizedContent },
        } satisfies ContentBlockFinishData)
      );
    } else if (Array.isArray(normalizedContent)) {
      for (let offset = 0; offset < normalizedContent.length; offset += 1) {
        const rawBlock = normalizedContent[offset];
        const block = normalizeProtocolFinalizedContentBlock(rawBlock);
        if (block == null) continue;

        const index = typeof block.index === "number" ? block.index : offset;
        await this.callbacks.pushEvent(
          this.callbacks.createMessagesEvent(namespace, {
            event: "content-block-start",
            index,
            content_block:
              block.type === "text"
                ? { type: "text", text: "" }
                : block.type === "reasoning"
                  ? { type: "reasoning", reasoning: "" }
                  : block,
          } satisfies ContentBlockStartData)
        );
        if (block.type === "text" && block.text.length > 0) {
          await this.callbacks.pushEvent(
            this.callbacks.createMessagesEvent(namespace, {
              event: "content-block-delta",
              index,
              content_block: { type: "text", text: block.text },
            } satisfies ContentBlockDeltaData)
          );
        } else if (block.type === "reasoning" && block.reasoning.length > 0) {
          await this.callbacks.pushEvent(
            this.callbacks.createMessagesEvent(namespace, {
              event: "content-block-delta",
              index,
              content_block: { type: "reasoning", reasoning: block.reasoning },
            } satisfies ContentBlockDeltaData)
          );
        }
        await this.callbacks.pushEvent(
          this.callbacks.createMessagesEvent(namespace, {
            event: "content-block-finish",
            index,
            content_block: block,
          } satisfies ContentBlockFinishData)
        );
      }
    }

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
    message: { id: string; type: MessageRole },
    state: MessageState
  ) {
    const { id, type } = message;
    if (state.started) return;

    await this.callbacks.pushEvent(
      this.callbacks.createMessagesEvent(namespace, {
        event: "message-start",
        role: type,
        message_id: id,
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
          content_block:
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
        content_block:
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
    contentBlock: ContentBlockFinishData["content_block"]
  ) {
    const existing = state.blocks.get(index);
    if (existing != null) return;

    await this.callbacks.pushEvent(
      this.callbacks.createMessagesEvent(namespace, {
        event: "content-block-start",
        index,
        content_block: contentBlock,
      } satisfies ContentBlockStartData)
    );
    await this.callbacks.pushEvent(
      this.callbacks.createMessagesEvent(namespace, {
        event: "content-block-finish",
        index,
        content_block: contentBlock,
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
          content_block: {
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
        content_block: {
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

      let contentBlock: ContentBlockFinishData["content_block"];
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
          content_block: contentBlock,
        } satisfies ContentBlockFinishData)
      );
      block.finished = true;
    }

    await this.callbacks.pushEvent(
      this.callbacks.createMessagesEvent(namespace, {
        event: "message-finish",
        reason: finishData.reason,
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
    const text = extractTextContent(normalizedContent) ?? "";
    const candidateNamespace =
      namespace.length > 0
        ? namespace
        : (toProtocolMessageNamespace(metadata) ?? state.namespace ?? []);
    const { namespace: aliasedNamespace, skipEmission } =
      this.resolveTaskToolNamespaceAlias(
        candidateNamespace,
        serialized.type,
        text
      );
    if (skipEmission) {
      return;
    }
    const resolvedNamespace = aliasedNamespace;
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
