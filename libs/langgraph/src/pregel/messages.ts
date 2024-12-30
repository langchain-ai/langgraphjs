import { v4 } from "uuid";
import {
  BaseCallbackHandler,
  HandleLLMNewTokenCallbackFields,
  NewTokenIndices,
} from "@langchain/core/callbacks/base";
import {
  AIMessageChunk,
  BaseMessage,
  isBaseMessage,
} from "@langchain/core/messages";
import { Serialized } from "@langchain/core/load/serializable";
import {
  ChatGeneration,
  ChatGenerationChunk,
  LLMResult,
} from "@langchain/core/outputs";
import { ChainValues } from "@langchain/core/utils/types";

import { StreamChunk } from "./loop.js";
import { TAG_HIDDEN, TAG_NOSTREAM } from "../constants.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Meta = [string[], Record<string, any>];

function isChatGenerationChunk(x: unknown): x is ChatGenerationChunk {
  return isBaseMessage((x as ChatGenerationChunk)?.message);
}

/**
 * A callback handler that implements stream_mode=messages.
 * Collects messages from (1) chat model stream events and (2) node outputs.
 */
// TODO: Make this import and explicitly implement the
// CallbackHandlerPrefersStreaming interface once we drop support for core 0.2
export class StreamMessagesHandler extends BaseCallbackHandler {
  name = "StreamMessagesHandler";

  streamFn: (streamChunk: StreamChunk) => void;

  metadatas: Record<string, Meta> = {};

  seen: Record<string, BaseMessage> = {};

  emittedChatModelRunIds: Record<string, boolean> = {};

  lc_prefer_streaming = true;

  constructor(streamFn: (streamChunk: StreamChunk) => void) {
    super();
    this.streamFn = streamFn;
  }

  _emit(meta: Meta, message: BaseMessage, dedupe = false) {
    if (
      dedupe &&
      message.id !== undefined &&
      this.seen[message.id] !== undefined
    ) {
      return;
    }
    if (message.id === undefined) {
      const id = v4();
      // eslint-disable-next-line no-param-reassign
      message.id = id;
      // eslint-disable-next-line no-param-reassign
      message.lc_kwargs.id = id;
    }
    this.seen[message.id!] = message;
    this.streamFn([meta[0], "messages", [message, meta[1]]]);
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
      // Include legacy LangGraph SDK tag
      (!tags || (!tags.includes(TAG_NOSTREAM) && !tags.includes("nostream")))
    ) {
      this.metadatas[runId] = [
        (metadata.langgraph_checkpoint_ns as string).split("|"),
        { tags, name, ...metadata },
      ];
    }
  }

  handleLLMNewToken(
    token: string,
    _idx: NewTokenIndices,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    fields?: HandleLLMNewTokenCallbackFields
  ) {
    const chunk = fields?.chunk;
    this.emittedChatModelRunIds[runId] = true;
    if (this.metadatas[runId] !== undefined) {
      if (isChatGenerationChunk(chunk)) {
        this._emit(this.metadatas[runId], chunk.message);
      } else {
        this._emit(
          this.metadatas[runId],
          new AIMessageChunk({
            content: token,
          })
        );
      }
    }
  }

  handleLLMEnd(output: LLMResult, runId: string) {
    // In JS, non-streaming runs do not call handleLLMNewToken at the model level
    if (!this.emittedChatModelRunIds[runId]) {
      const chatGeneration = output.generations?.[0]?.[0] as ChatGeneration;
      if (isBaseMessage(chatGeneration?.message)) {
        this._emit(this.metadatas[runId], chatGeneration?.message, true);
      }
      delete this.emittedChatModelRunIds[runId];
    }
    delete this.metadatas[runId];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleLLMError(_err: any, runId: string) {
    delete this.metadatas[runId];
  }

  handleChainStart(
    _chain: Serialized,
    _inputs: ChainValues,
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
    }
  }

  handleChainEnd(outputs: ChainValues, runId: string) {
    const metadata = this.metadatas[runId];
    delete this.metadatas[runId];
    if (metadata !== undefined) {
      if (isBaseMessage(outputs)) {
        this._emit(metadata, outputs, true);
      } else if (Array.isArray(outputs)) {
        for (const value of outputs) {
          if (isBaseMessage(value)) {
            this._emit(metadata, value, true);
          }
        }
      } else if (outputs != null && typeof outputs === "object") {
        for (const value of Object.values(outputs)) {
          if (isBaseMessage(value)) {
            this._emit(metadata, value, true);
          } else if (Array.isArray(value)) {
            for (const item of value) {
              if (isBaseMessage(item)) {
                this._emit(metadata, item, true);
              }
            }
          }
        }
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleChainError(_err: any, runId: string) {
    delete this.metadatas[runId];
  }
}
