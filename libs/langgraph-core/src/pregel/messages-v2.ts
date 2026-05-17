import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import {
  BaseMessage,
  isBaseMessage,
  isBaseMessageChunk,
  isToolMessage,
} from "@langchain/core/messages";
import { Serialized } from "@langchain/core/load/serializable";
import { ChatGeneration, LLMResult } from "@langchain/core/outputs";
import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";
import { ChainValues } from "@langchain/core/utils/types";

import { TAG_HIDDEN, TAG_NOSTREAM } from "../constants.js";
import { StreamChunk } from "./stream.js";

type Meta = [string[], Record<string, unknown>];
type CompatibleContentBlock = { type: string; [key: string]: unknown };

function getResponseMetadata(
  message: BaseMessage
): Record<string, unknown> | undefined {
  if (
    "response_metadata" in message &&
    typeof message.response_metadata === "object" &&
    message.response_metadata != null
  ) {
    return message.response_metadata as Record<string, unknown>;
  }
  return undefined;
}

function getUsageMetadata(
  message: BaseMessage
): Record<string, unknown> | undefined {
  if (
    "usage_metadata" in message &&
    typeof message.usage_metadata === "object" &&
    message.usage_metadata != null
  ) {
    return message.usage_metadata as Record<string, unknown>;
  }
  return undefined;
}

function startBlockFor(block: CompatibleContentBlock): CompatibleContentBlock {
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
}

function deltaFor(
  block: CompatibleContentBlock
): ChatModelStreamEvent | undefined {
  switch (block.type) {
    case "text": {
      const text = typeof block.text === "string" ? block.text : "";
      return text.length > 0
        ? {
            event: "content-block-delta",
            index: typeof block.index === "number" ? block.index : 0,
            delta: { type: "text-delta", text },
          }
        : undefined;
    }
    case "reasoning": {
      const reasoning =
        typeof block.reasoning === "string" ? block.reasoning : "";
      return reasoning.length > 0
        ? {
            event: "content-block-delta",
            index: typeof block.index === "number" ? block.index : 0,
            delta: { type: "reasoning-delta", reasoning },
          }
        : undefined;
    }
    case "tool_call_chunk":
      return {
        event: "content-block-delta",
        index: typeof block.index === "number" ? block.index : 0,
        delta: {
          type: "block-delta",
          fields: { ...block, type: "tool_call_chunk" },
        },
      };
    default:
      return undefined;
  }
}

/**
 * A callback handler that implements protocol-native stream_mode=messages.
 *
 * LangChain Core owns chat model content-block event construction. This handler
 * only captures LangGraph metadata, forwards Core events to the Pregel messages
 * channel, and emits a small non-streaming fallback for models that cannot
 * produce stream events.
 */
export class StreamProtocolMessagesHandler extends BaseCallbackHandler {
  name = "StreamProtocolMessagesHandler";

  streamFn: (streamChunk: StreamChunk) => void;

  metadatas: Record<string, Meta | undefined> = {};

  seen: Record<string, BaseMessage | true> = {};

  streamedRunIds = new Set<string>();

  stableMessageIdMap: Record<string, string> = {};

  lc_prefer_chat_model_stream_events = true;

  constructor(streamFn: (streamChunk: StreamChunk) => void) {
    super();
    this.streamFn = streamFn;
  }

  private normalizeMessageId(message: BaseMessage, runId: string | undefined) {
    let messageId = message.id;

    if (runId != null) {
      if (isToolMessage(message)) {
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

  private emit(meta: Meta, data: ChatModelStreamEvent, runId?: string) {
    const metadata = runId != null ? { ...meta[1], run_id: runId } : meta[1];
    this.streamFn([meta[0], "messages", [data, metadata]]);
  }

  private emitFinalMessage(
    meta: Meta,
    message: BaseMessage,
    runId: string | undefined,
    dedupe = false
  ) {
    const existingId =
      message.id ??
      (runId != null ? this.stableMessageIdMap[runId] : undefined);
    if (dedupe && existingId != null && this.seen[existingId] !== undefined) {
      return;
    }

    const messageId = this.normalizeMessageId(message, runId);
    const role =
      message.type === "human"
        ? "human"
        : message.type === "system"
          ? "system"
          : message.type === "tool"
            ? "tool"
            : "ai";
    const toolCallId =
      role === "tool" && isToolMessage(message)
        ? message.tool_call_id
        : undefined;

    this.emit(
      meta,
      {
        event: "message-start",
        ...(messageId != null ? { id: messageId } : {}),
        ...(role !== "ai" ? ({ role } as Record<string, unknown>) : {}),
        ...(typeof toolCallId === "string"
          ? ({ tool_call_id: toolCallId } as Record<string, unknown>)
          : {}),
      } as ChatModelStreamEvent,
      runId
    );

    const contentBlocks: CompatibleContentBlock[] = Array.isArray(
      message.content
    )
      ? (message.content as CompatibleContentBlock[])
      : typeof message.content === "string" && message.content.length > 0
        ? [{ type: "text", text: message.content }]
        : [];

    contentBlocks.forEach((block, offset) => {
      const index = typeof block.index === "number" ? block.index : offset;
      this.emit(
        meta,
        {
          event: "content-block-start",
          index,
          content: startBlockFor(block),
        },
        runId
      );
      const delta = deltaFor({ ...block, index });
      if (delta != null) {
        this.emit(meta, delta, runId);
      }
      this.emit(
        meta,
        {
          event: "content-block-finish",
          index,
          content: block,
        },
        runId
      );
    });

    this.emit(
      meta,
      {
        event: "message-finish",
        ...(getUsageMetadata(message) != null
          ? { usage: getUsageMetadata(message) }
          : {}),
        ...(getResponseMetadata(message) != null
          ? { responseMetadata: getResponseMetadata(message) }
          : {}),
      },
      runId
    );
  }

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

  handleLLMNewToken() {
    // Core v2 stream events are forwarded via handleChatModelStreamEvent.
  }

  handleChatModelStreamEvent(event: ChatModelStreamEvent, runId: string) {
    const meta = this.metadatas[runId];
    if (meta === undefined) return;

    let forwarded = event;
    if (event.event === "message-start") {
      this.streamedRunIds.add(runId);
      const id = event.id ?? `run-${runId}`;
      this.seen[id] = true;
      this.stableMessageIdMap[runId] ??= id;
      if (event.id == null) {
        forwarded = { ...event, id };
      }
    }

    this.emit(meta, forwarded, runId);
  }

  handleLLMEnd(output: LLMResult, runId: string) {
    const meta = this.metadatas[runId];
    if (meta === undefined) return;

    const chatGeneration = output.generations?.[0]?.[0] as ChatGeneration;
    const message = isBaseMessage(chatGeneration?.message)
      ? chatGeneration.message
      : undefined;

    if (message != null) {
      if (this.streamedRunIds.has(runId)) {
        const messageId = this.normalizeMessageId(message, runId);
        if (messageId != null) this.seen[messageId] = message;
      } else {
        this.emitFinalMessage(meta, message, runId, true);
      }
    }

    this.streamedRunIds.delete(runId);
    delete this.metadatas[runId];
    delete this.stableMessageIdMap[runId];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleLLMError(_err: any, runId: string) {
    this.streamedRunIds.delete(runId);
    delete this.metadatas[runId];
    delete this.stableMessageIdMap[runId];
  }

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
            (isBaseMessage(value) || isBaseMessageChunk(value)) &&
            value.id !== undefined
          ) {
            this.seen[value.id] = value;
          } else if (Array.isArray(value)) {
            for (const item of value) {
              if (
                (isBaseMessage(item) || isBaseMessageChunk(item)) &&
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

  handleChainEnd(outputs: ChainValues, runId: string) {
    const meta = this.metadatas[runId];
    delete this.metadatas[runId];
    if (meta === undefined) return;

    const emitMessage = (value: unknown) => {
      if (isBaseMessage(value)) {
        this.emitFinalMessage(meta, value, runId, true);
      }
    };

    if (isBaseMessage(outputs)) {
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

    delete this.stableMessageIdMap[runId];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleChainError(_err: any, runId: string) {
    delete this.metadatas[runId];
    delete this.stableMessageIdMap[runId];
  }
}
