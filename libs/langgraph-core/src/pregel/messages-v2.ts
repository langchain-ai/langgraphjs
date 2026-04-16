import {
  BaseCallbackHandler,
  HandleLLMNewTokenCallbackFields,
  NewTokenIndices,
} from "@langchain/core/callbacks/base";
import {
  AIMessageChunk,
  BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { Serialized } from "@langchain/core/load/serializable";
import {
  ChatGeneration,
  ChatGenerationChunk,
  LLMResult,
} from "@langchain/core/outputs";
import { ChainValues } from "@langchain/core/utils/types";

import { TAG_HIDDEN, TAG_NOSTREAM } from "../constants.js";
import { StreamChunk } from "./stream.js";

type Meta = [string[], Record<string, unknown>];
type CompatibleContentBlock = { type: string; [key: string]: unknown };
type UsageMetadataLike = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_token_details?: Record<string, unknown>;
  output_token_details?: Record<string, unknown>;
};

/**
 * also defined in libs/langgraph-api/src/protocol/constants.mts
 */
export const PROTOCOL_MESSAGES_STREAM_CONFIG_KEY = "__protocol_messages_stream";

/**
 * Checks whether protocol-native message streaming is enabled for a run.
 *
 * The flag is carried in the metadata/configurable payload that LangGraph
 * attaches to model and chain callbacks. When absent, callers should fall back
 * to the legacy message tuple path.
 *
 * @param meta - Namespace and metadata tuple associated with the current run.
 * @returns Whether the protocol-native message stream should be used.
 */
const isProtocolMessagesStreamEnabled = (meta: Meta | undefined) =>
  meta?.[1]?.[PROTOCOL_MESSAGES_STREAM_CONFIG_KEY] === true;

/**
 * Narrows an arbitrary value to the usage metadata shape used by streamed chat
 * model chunks.
 *
 * @param value - Candidate usage payload.
 * @returns Whether the value looks like usage metadata.
 */
const isUsageMetadataLike = (value: unknown): value is UsageMetadataLike =>
  typeof value === "object" &&
  value != null &&
  "input_tokens" in value &&
  "output_tokens" in value &&
  "total_tokens" in value;

/**
 * Normalizes provider-specific stop reasons into the protocol-compatible enum.
 *
 * @param value - Raw stop reason from provider metadata.
 * @returns Normalized protocol finish reason.
 */
const normalizeMessageFinishReason = (value: unknown) => {
  switch (value) {
    case "length":
    case "content_filter":
      return value;
    case "tool_use":
    case "tool_calls":
      return "tool_use";
    default:
      return "stop";
  }
};

/**
 * Merges an incoming content block snapshot into the accumulated block state
 * for the same index.
 *
 * Text, reasoning, and tool-call chunks are concatenated incrementally while
 * unknown block types are merged shallowly.
 *
 * @param accumulated - Previously accumulated block state.
 * @param delta - New block snapshot or delta to merge in.
 * @returns Updated accumulated block state.
 */
const accumulateContentBlock = (
  accumulated: CompatibleContentBlock,
  delta: CompatibleContentBlock
): CompatibleContentBlock => {
  if (accumulated.type === "text" && delta.type === "text") {
    return {
      ...accumulated,
      type: "text",
      text: `${String(accumulated.text ?? "")}${String(delta.text ?? "")}`,
    };
  }

  if (accumulated.type === "reasoning" && delta.type === "reasoning") {
    return {
      ...accumulated,
      type: "reasoning",
      reasoning: `${String(accumulated.reasoning ?? "")}${String(
        delta.reasoning ?? ""
      )}`,
    };
  }

  if (
    (accumulated.type === "tool_call_chunk" ||
      accumulated.type === "tool_call") &&
    (delta.type === "tool_call_chunk" || delta.type === "tool_call")
  ) {
    return {
      ...accumulated,
      type: "tool_call_chunk",
      id: accumulated.id ?? delta.id,
      name: accumulated.name ?? delta.name,
      args: `${String(accumulated.args ?? "")}${String(delta.args ?? "")}`,
    };
  }

  return { ...accumulated, ...delta };
};

/**
 * Finalizes a block before emitting `content-block-finish`.
 *
 * Tool call chunks are upgraded into finalized tool calls by parsing their JSON
 * argument buffer. If parsing fails, an invalid tool call block is emitted so
 * consumers can still render the failure deterministically.
 *
 * @param block - Accumulated block state for a single content index.
 * @returns Finalized protocol-facing block.
 */
const finalizeContentBlock = (
  block: CompatibleContentBlock
): CompatibleContentBlock => {
  if (block.type !== "tool_call_chunk") return block;

  try {
    return {
      type: "tool_call",
      id: block.id,
      name: block.name,
      args: JSON.parse(String(block.args ?? "{}")),
    };
  } catch {
    return {
      type: "invalid_tool_call",
      id: block.id,
      name: block.name,
      args: block.args,
      error: "Failed to parse tool call arguments as JSON",
    };
  }
};

/**
 * Converts LangChain's `usage_metadata` into the protocol's
 * `UsageInfo` shape defined by `@langchain/protocol`.
 *
 * @param usage - LangChain-format usage metadata.
 * @returns Protocol-compatible usage info, or `undefined` if input is nullish.
 */
const toProtocolUsage = (
  usage: UsageMetadataLike | undefined
): Record<string, unknown> | undefined => {
  if (usage == null) return undefined;
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.input_token_details != null
      ? { input_token_details: usage.input_token_details }
      : {}),
    ...(usage.output_token_details != null
      ? { output_token_details: usage.output_token_details }
      : {}),
  };
};

/**
 * Combines additive usage metadata emitted by chunk streams into a running
 * snapshot.
 *
 * The chunk-based callback path reports usage incrementally, so the handler
 * needs to accumulate totals before forwarding them as protocol-friendly
 * snapshots.
 *
 * @param current - Current accumulated usage snapshot, if any.
 * @param next - Incoming usage payload from the latest chunk.
 * @returns Updated usage snapshot or the existing snapshot when no usage is present.
 */
const accumulateUsageMetadata = (
  current: UsageMetadataLike | undefined,
  next: unknown
): UsageMetadataLike | undefined => {
  if (!isUsageMetadataLike(next)) return current;
  if (current == null) return { ...next };
  return {
    input_tokens: current.input_tokens + next.input_tokens,
    output_tokens: current.output_tokens + next.output_tokens,
    total_tokens: current.total_tokens + next.total_tokens,
    ...(current.input_token_details != null || next.input_token_details != null
      ? {
          input_token_details: {
            ...(current.input_token_details ?? {}),
            ...(next.input_token_details ?? {}),
          },
        }
      : {}),
    ...(current.output_token_details != null ||
    next.output_token_details != null
      ? {
          output_token_details: {
            ...(current.output_token_details ?? {}),
            ...(next.output_token_details ?? {}),
          },
        }
      : {}),
  };
};

/**
 * Produces the initial content block shape for a `content-block-start` event.
 *
 * Protocol clients expect text/reasoning/tool-call blocks to start with empty
 * payloads and receive their data through later delta or finish events.
 *
 * @param block - The first observed snapshot for a content block.
 * @returns Empty or normalized block payload suitable for a start event.
 */
const toProtocolStartBlock = (
  block: CompatibleContentBlock
): CompatibleContentBlock => {
  switch (block.type) {
    case "text":
      return { type: "text", text: "" };
    case "reasoning":
      return { type: "reasoning", reasoning: "" };
    case "tool_call":
    case "tool_call_chunk":
      return {
        type: "tool_call_chunk",
        ...(block.id != null ? { id: block.id } : {}),
        ...(block.name != null ? { name: block.name } : {}),
        args: "",
      };
    default:
      return block;
  }
};

/**
 * Computes the incremental protocol delta between two accumulated block states.
 *
 * The upstream callback path provides accumulated snapshots, while protocol
 * consumers in this repository expect deltas that contain only the newly added
 * text, reasoning, or tool-call argument segment.
 *
 * @param previous - Previously emitted accumulated block state.
 * @param next - Newly accumulated block state.
 * @returns Incremental block delta, or `undefined` when nothing new was added.
 */
const toProtocolDeltaBlock = (
  previous: CompatibleContentBlock,
  next: CompatibleContentBlock
): CompatibleContentBlock | undefined => {
  switch (next.type) {
    case "text": {
      const previousText =
        previous.type === "text" ? String(previous.text ?? "") : "";
      const nextText = String(next.text ?? "");
      const delta = nextText.startsWith(previousText)
        ? nextText.slice(previousText.length)
        : nextText;
      return delta.length > 0 ? { type: "text", text: delta } : undefined;
    }
    case "reasoning": {
      const previousReasoning =
        previous.type === "reasoning" ? String(previous.reasoning ?? "") : "";
      const nextReasoning = String(next.reasoning ?? "");
      const delta = nextReasoning.startsWith(previousReasoning)
        ? nextReasoning.slice(previousReasoning.length)
        : nextReasoning;
      return delta.length > 0
        ? { type: "reasoning", reasoning: delta }
        : undefined;
    }
    case "tool_call_chunk": {
      const previousArgs =
        previous.type === "tool_call_chunk" ? String(previous.args ?? "") : "";
      const nextArgs = String(next.args ?? "");
      const deltaArgs = nextArgs.startsWith(previousArgs)
        ? nextArgs.slice(previousArgs.length)
        : nextArgs;
      const hasMetadata = next.id != null || next.name != null;
      if (deltaArgs.length === 0 && !hasMetadata) {
        return undefined;
      }
      return {
        type: "tool_call_chunk",
        ...(next.id != null ? { id: next.id } : {}),
        ...(next.name != null ? { name: next.name } : {}),
        args: deltaArgs,
      };
    }
    default:
      return next;
  }
};

/**
 * Checks whether a callback field contains a chat generation chunk.
 *
 * @param x - Candidate chunk payload from `handleLLMNewToken`.
 * @returns Whether the value is a chat generation chunk with a message payload.
 */
function isChatGenerationChunk(x: unknown): x is ChatGenerationChunk {
  return BaseMessage.isInstance((x as ChatGenerationChunk)?.message);
}

interface ProtocolStreamRunState {
  /** Stable message ID associated with the active streamed response. */
  messageId?: string;
  /** Whether a `message-start` event has been emitted. */
  started: boolean;
  /** Accumulated block state keyed by content block index. */
  blocks: Map<number, CompatibleContentBlock>;
  /** Running usage snapshot built from streamed chunks. */
  usage?: UsageMetadataLike;
}

/**
 * A callback handler that implements stream_mode=messages for protocol runs.
 * Emits protocol-native message lifecycle events instead of message tuples.
 */
export class StreamProtocolMessagesHandler extends BaseCallbackHandler {
  name = "StreamProtocolMessagesHandler";

  streamFn: (streamChunk: StreamChunk) => void;

  metadatas: Record<string, Meta | undefined> = {};

  seen: Record<string, BaseMessage> = {};

  emittedChatModelRunIds: Record<string, boolean> = {};

  stableMessageIdMap: Record<string, string> = {};

  protocolRuns: Record<string, ProtocolStreamRunState | undefined> = {};

  lc_prefer_streaming = true;

  /**
   * Creates a protocol-native message stream handler.
   *
   * @param streamFn - Sink that receives namespaced stream chunks produced by this handler.
   */
  constructor(streamFn: (streamChunk: StreamChunk) => void) {
    super();
    this.streamFn = streamFn;
  }

  /**
   * Assigns a stable message ID for a streamed run and records the latest
   * message instance for deduplication.
   *
   * @param message - Message or chunk being normalized.
   * @param runId - Callback run identifier associated with the message.
   * @returns Stable message ID after normalization.
   */
  private normalizeMessageId(message: BaseMessage, runId: string | undefined) {
    let messageId = message.id;

    if (runId != null) {
      if (ToolMessage.isInstance(message)) {
        messageId ??= `run-${runId}-tool-${message.tool_call_id}`;
      } else {
        if (messageId == null || messageId === `run-${runId}`) {
          messageId =
            this.stableMessageIdMap[runId] ?? messageId ?? `run-${runId}`;
        }

        this.stableMessageIdMap[runId] ??= messageId;
      }
    }

    if (messageId !== message.id) {
      // eslint-disable-next-line no-param-reassign
      message.id = messageId;

      // eslint-disable-next-line no-param-reassign
      message.lc_kwargs.id = messageId;
    }

    if (message.id != null) this.seen[message.id] = message;
    return message.id;
  }

  /**
   * Emits a protocol `messages` stream chunk for the run namespace.
   *
   * @param meta - Namespace and metadata tuple associated with the active run.
   * @param data - Protocol-formatted message lifecycle payload.
   */
  private emitProtocolEvent(meta: Meta, data: Record<string, unknown>) {
    this.streamFn([meta[0], "messages", data]);
  }

  /**
   * Looks up or initializes the mutable state used to track one streamed model
   * response.
   *
   * @param runId - Callback run identifier for the active model invocation.
   * @returns Mutable protocol stream state for the run.
   */
  private ensureProtocolRun(runId: string) {
    const existing = this.protocolRuns[runId];
    if (existing != null) return existing;
    const created: ProtocolStreamRunState = {
      started: false,
      blocks: new Map(),
      usage: undefined,
    };
    this.protocolRuns[runId] = created;
    return created;
  }

  /**
   * Emits `message-start` exactly once for a streamed response.
   *
   * @param runState - Mutable stream state for the run.
   * @param meta - Namespace and metadata tuple associated with the run.
   * @param messageId - Stable message ID, if one is known.
   */
  private ensureMessageStarted(
    runState: ProtocolStreamRunState,
    meta: Meta,
    messageId: string | undefined
  ) {
    if (runState.started) return;
    runState.started = true;
    runState.messageId = messageId;
    this.emitProtocolEvent(meta, {
      event: "message-start",
      role: "ai",
      ...(messageId != null ? { message_id: messageId } : {}),
    });
  }

  /**
   * Emits protocol start/delta events for a single content block update and
   * stores the accumulated block state for later finish emission.
   *
   * @param runState - Mutable stream state for the run.
   * @param meta - Namespace and metadata tuple associated with the run.
   * @param index - Content block index being updated.
   * @param deltaBlock - Incoming block snapshot or delta for the index.
   */
  private emitBlockDelta(
    runState: ProtocolStreamRunState,
    meta: Meta,
    index: number,
    deltaBlock: CompatibleContentBlock
  ) {
    const previous =
      runState.blocks.get(index) ?? toProtocolStartBlock(deltaBlock);

    if (!runState.blocks.has(index)) {
      this.emitProtocolEvent(meta, {
        event: "content-block-start",
        index,
        content_block: previous,
      });
    }

    const next = accumulateContentBlock(previous, deltaBlock);
    const protocolDelta = toProtocolDeltaBlock(previous, next);
    runState.blocks.set(index, next);

    if (protocolDelta == null) return;

    this.emitProtocolEvent(meta, {
      event: "content-block-delta",
      index,
      content_block: protocolDelta,
    });
  }

  /**
   * Emits a full protocol message lifecycle for a finalized message.
   *
   * This is used for non-streaming completions and chain outputs where the
   * handler receives only the final `BaseMessage`.
   *
   * @param meta - Namespace and metadata tuple associated with the run.
   * @param message - Final message to convert into protocol lifecycle events.
   * @param runId - Callback run identifier associated with the message.
   * @param dedupe - Whether to suppress emission when the message was already seen.
   */
  private emitProtocolFinalMessage(
    meta: Meta,
    message: BaseMessage,
    runId: string | undefined,
    dedupe = false
  ) {
    if (dedupe) {
      const existingId =
        message.id ??
        (runId != null ? this.stableMessageIdMap[runId] : undefined);
      if (existingId != null && existingId in this.seen) {
        return;
      }
    }
    const messageId = this.normalizeMessageId(message, runId);

    const role =
      message.type === "human"
        ? "human"
        : message.type === "system"
          ? "system"
          : message.type === "tool"
            ? ("tool" as const)
            : "ai";
    this.emitProtocolEvent(meta, {
      event: "message-start",
      role,
      ...(messageId != null ? { message_id: messageId } : {}),
    });

    const normalizedContent = Array.isArray(message.content)
      ? message.content
      : [{ type: "text", text: String(message.content ?? ""), index: 0 }];

    for (let offset = 0; offset < normalizedContent.length; offset += 1) {
      const rawBlock = normalizedContent[offset] as CompatibleContentBlock & {
        index?: number;
      };
      const index =
        typeof rawBlock.index === "number" ? rawBlock.index : offset;
      const startBlock = toProtocolStartBlock(rawBlock);
      this.emitProtocolEvent(meta, {
        event: "content-block-start",
        index,
        content_block: startBlock,
      });

      const deltaBlock = toProtocolDeltaBlock(startBlock, rawBlock);
      if (deltaBlock != null) {
        this.emitProtocolEvent(meta, {
          event: "content-block-delta",
          index,
          content_block: deltaBlock,
        });
      }

      this.emitProtocolEvent(meta, {
        event: "content-block-finish",
        index,
        content_block:
          rawBlock.type === "tool_call"
            ? rawBlock
            : rawBlock.type === "tool_call_chunk"
              ? finalizeContentBlock(rawBlock)
              : rawBlock,
      });
    }

    const responseMetadata =
      "response_metadata" in message &&
      typeof message.response_metadata === "object" &&
      message.response_metadata != null
        ? (message.response_metadata as Record<string, unknown>)
        : undefined;
    const finishReason = normalizeMessageFinishReason(
      responseMetadata?.stop_reason
    );
    const usage =
      "usage_metadata" in message && isUsageMetadataLike(message.usage_metadata)
        ? message.usage_metadata
        : undefined;
    const protocolUsage = toProtocolUsage(usage);

    this.emitProtocolEvent(meta, {
      event: "message-finish",
      reason: finishReason,
      ...(protocolUsage != null ? { usage: protocolUsage } : {}),
      ...(responseMetadata != null ? { metadata: responseMetadata } : {}),
    });
  }

  /**
   * Captures per-run metadata at chat model start so later token callbacks can
   * be mapped onto the correct namespace.
   *
   * @param _llm - Serialized model payload from the callback system.
   * @param _messages - Input messages supplied to the model.
   * @param runId - Callback run identifier for the model invocation.
   * @param _parentRunId - Optional parent callback run identifier.
   * @param _extraParams - Additional callback metadata supplied by the runtime.
   * @param tags - Callback tags for the run.
   * @param metadata - Callback metadata for the run.
   * @param name - Optional callback run name.
   */
  handleChatModelStart(
    _llm: Serialized,
    _messages: BaseMessage[][],
    runId: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    name?: string
  ) {
    if (
      metadata &&
      (!tags || (!tags.includes(TAG_NOSTREAM) && !tags.includes("nostream")))
    ) {
      this.metadatas[runId] = [
        (metadata.langgraph_checkpoint_ns as string).split("|"),
        { tags, name, ...metadata },
      ];
    }
  }

  /**
   * Consumes streamed model chunks and emits protocol-native lifecycle events.
   *
   * @param token - Token string supplied by the callback interface.
   * @param _idx - Prompt/completion indices for the token.
   * @param runId - Callback run identifier for the model invocation.
   * @param _parentRunId - Optional parent callback run identifier.
   * @param _tags - Optional callback tags for the token event.
   * @param fields - Optional callback fields containing the underlying chunk.
   */
  handleLLMNewToken(
    token: string,
    _idx: NewTokenIndices,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    fields?: HandleLLMNewTokenCallbackFields
  ) {
    this.emittedChatModelRunIds[runId] = true;
    const meta = this.metadatas[runId];
    if (!isProtocolMessagesStreamEnabled(meta)) return;

    const chunk = fields?.chunk;
    const message = isChatGenerationChunk(chunk)
      ? chunk.message
      : new AIMessageChunk({ content: token });
    const messageId = this.normalizeMessageId(message, runId);
    const runState = this.ensureProtocolRun(runId);
    this.ensureMessageStarted(runState, meta!, messageId);

    if (typeof message.content === "string") {
      if (message.content.length > 0) {
        this.emitBlockDelta(runState, meta!, 0, {
          type: "text",
          text: message.content,
        });
      }
    } else if (Array.isArray(message.content)) {
      for (let offset = 0; offset < message.content.length; offset += 1) {
        const rawBlock = message.content[offset] as CompatibleContentBlock & {
          index?: number;
        };
        const index =
          typeof rawBlock.index === "number" ? rawBlock.index : offset;
        switch (rawBlock.type) {
          case "text":
          case "reasoning":
          case "tool_call_chunk":
            this.emitBlockDelta(runState, meta!, index, rawBlock);
            break;
          default:
            if (!runState.blocks.has(index)) {
              runState.blocks.set(index, rawBlock);
              this.emitProtocolEvent(meta!, {
                event: "content-block-start",
                index,
                content_block: rawBlock,
              });
            }
            break;
        }
      }
    }

    if (
      AIMessageChunk.isInstance(message) &&
      Array.isArray(message.tool_call_chunks)
    ) {
      for (
        let offset = 0;
        offset < message.tool_call_chunks.length;
        offset += 1
      ) {
        const toolChunk = message.tool_call_chunks[offset];
        const index =
          typeof toolChunk.index === "number" ? toolChunk.index : offset;
        this.emitBlockDelta(runState, meta!, index, {
          type: "tool_call_chunk",
          ...(toolChunk.id != null ? { id: toolChunk.id } : {}),
          ...(toolChunk.name != null ? { name: toolChunk.name } : {}),
          args: toolChunk.args ?? "",
        } satisfies CompatibleContentBlock);
      }
    }

    if (AIMessageChunk.isInstance(message)) {
      runState.usage = accumulateUsageMetadata(
        runState.usage,
        message.usage_metadata
      );
    }
  }

  /**
   * Finalizes an active streamed model response and emits any remaining
   * `content-block-finish` and `message-finish` events.
   *
   * @param output - Final LLM result produced by the model invocation.
   * @param runId - Callback run identifier for the model invocation.
   */
  handleLLMEnd(output: LLMResult, runId: string) {
    const meta = this.metadatas[runId];
    if (!isProtocolMessagesStreamEnabled(meta)) {
      delete this.metadatas[runId];
      delete this.stableMessageIdMap[runId];
      return;
    }

    const runState = this.protocolRuns[runId];
    const chatGeneration = output.generations?.[0]?.[0] as ChatGeneration;
    const message = BaseMessage.isInstance(chatGeneration?.message)
      ? chatGeneration.message
      : undefined;

    if (runState == null || !runState.started) {
      if (message != null) {
        this.emitProtocolFinalMessage(meta!, message, runId, true);
      }
    } else {
      const finishUsage =
        message != null &&
        "usage_metadata" in message &&
        isUsageMetadataLike(message.usage_metadata)
          ? message.usage_metadata
          : runState.usage;
      const responseMetadata =
        message != null &&
        "response_metadata" in message &&
        typeof message.response_metadata === "object" &&
        message.response_metadata != null
          ? (message.response_metadata as Record<string, unknown>)
          : undefined;

      for (const [index, block] of [...runState.blocks.entries()].sort(
        ([left], [right]) => left - right
      )) {
        this.emitProtocolEvent(meta!, {
          event: "content-block-finish",
          index,
          content_block: finalizeContentBlock(block),
        });
      }

      const protocolUsage = toProtocolUsage(finishUsage);
      this.emitProtocolEvent(meta!, {
        event: "message-finish",
        reason: normalizeMessageFinishReason(responseMetadata?.stop_reason),
        ...(protocolUsage != null ? { usage: protocolUsage } : {}),
        ...(responseMetadata != null ? { metadata: responseMetadata } : {}),
      });
    }

    delete this.protocolRuns[runId];
    delete this.emittedChatModelRunIds[runId];
    delete this.metadatas[runId];
    delete this.stableMessageIdMap[runId];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  /**
   * Cleans up protocol stream state when the model invocation fails.
   *
   * @param _err - Error raised by the model invocation.
   * @param runId - Callback run identifier for the failed model invocation.
   */
  handleLLMError(_err: any, runId: string) {
    delete this.protocolRuns[runId];
    delete this.metadatas[runId];
    delete this.stableMessageIdMap[runId];
  }

  /**
   * Captures namespace metadata for chain callbacks so finalized chain outputs
   * can be emitted as protocol-native message lifecycles.
   *
   * @param _chain - Serialized chain payload from the callback system.
   * @param inputs - Input values passed to the chain.
   * @param runId - Callback run identifier for the chain invocation.
   * @param _parentRunId - Optional parent callback run identifier.
   * @param tags - Callback tags for the chain run.
   * @param metadata - Callback metadata for the chain run.
   * @param _runType - Optional callback run type.
   * @param name - Optional callback run name.
   */
  handleChainStart(
    _chain: Serialized,
    inputs: ChainValues,
    runId: string,
    _parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    _runType?: string,
    name?: string
  ) {
    if (
      metadata !== undefined &&
      name === metadata.langgraph_node &&
      (tags === undefined || !tags.includes(TAG_HIDDEN))
    ) {
      this.metadatas[runId] = [
        (metadata.langgraph_checkpoint_ns as string).split("|"),
        { tags, name, ...metadata },
      ];

      if (typeof inputs === "object") {
        for (const value of Object.values(inputs)) {
          if (
            (BaseMessage.isInstance(value) ||
              AIMessageChunk.isInstance(value)) &&
            value.id !== undefined
          ) {
            this.seen[value.id] = value;
          } else if (Array.isArray(value)) {
            for (const item of value) {
              if (
                (BaseMessage.isInstance(item) ||
                  AIMessageChunk.isInstance(item)) &&
                item.id !== undefined
              ) {
                this.seen[item.id] = item;
              }
            }
          }
        }
      }
    }
  }

  /**
   * Converts finalized chain message outputs into protocol-native lifecycle
   * events.
   *
   * @param outputs - Final chain output payload.
   * @param runId - Callback run identifier for the chain invocation.
   */
  handleChainEnd(outputs: ChainValues, runId: string) {
    const meta = this.metadatas[runId];
    if (!isProtocolMessagesStreamEnabled(meta)) {
      delete this.metadatas[runId];
      return;
    }

    const emitMessage = (value: unknown) => {
      if (BaseMessage.isInstance(value)) {
        this.emitProtocolFinalMessage(meta!, value, runId, true);
      }
    };

    if (BaseMessage.isInstance(outputs)) {
      emitMessage(outputs);
    } else if (Array.isArray(outputs)) {
      for (const value of outputs) emitMessage(value);
    } else if (outputs != null && typeof outputs === "object") {
      for (const value of Object.values(outputs)) {
        if (Array.isArray(value)) {
          for (const item of value) emitMessage(item);
        } else {
          emitMessage(value);
        }
      }
    }

    delete this.metadatas[runId];
    delete this.stableMessageIdMap[runId];
  }

  /**
   * Cleans up chain-scoped metadata when a chain callback fails.
   *
   * @param _err - Error raised by the chain invocation.
   * @param runId - Callback run identifier for the failed chain invocation.
   */
  handleChainError(_err: any, runId: string) {
    delete this.metadatas[runId];
    delete this.stableMessageIdMap[runId];
  }
}
