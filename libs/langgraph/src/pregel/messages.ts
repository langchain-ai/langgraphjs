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
import { v4 } from "uuid";

import { StreamChunk } from "./loop.js";
import { Serialized } from "@langchain/core/load/serializable";
import { TAG_HIDDEN, TAG_NOSTREAM } from "../constants.js";
import { ChatGenerationChunk, LLMResult } from "@langchain/core/outputs";
import { ChainValues } from "@langchain/core/utils/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Meta = [string[], Record<string, any>];

function isChatGenerationChunk(x: unknown): x is ChatGenerationChunk {
  return isBaseMessage((x as ChatGenerationChunk)?.message);
}

/**
 * A callback handler that implements stream_mode=messages.
 * Collects messages from (1) chat model stream events and (2) node outputs.
 */
export class StreamMessagesHandler extends BaseCallbackHandler {
  name = "StreamMessagesHandler";

  streamFn: (streamChunk: StreamChunk) => void;

  metadatas: Record<string, Meta> = {};

  seen: Record<string, BaseMessage> = {};

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
      message.id = v4();
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
    metadata?: Record<string, unknown>
  ) {
    if (
      metadata &&
      // Include legacy LangGraph SDK tag
      (!tags || !(tags.includes(TAG_NOSTREAM) && tags.includes("nostream")))
    ) {
      this.metadatas[runId] = [
        (metadata.langgraph_checkpoint_ns as string).split("NS_SEP"),
        metadata,
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
    if (isChatGenerationChunk(chunk) && this.metadatas[runId] !== undefined) {
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

  handleLLMEnd(_output: LLMResult, runId: string) {
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
    runName?: string
  ) {
    console.log(runName, metadata, tags);
    if (
      metadata !== undefined &&
      runName === metadata.langgraph_node &&
      (tags === undefined || !tags.includes(TAG_HIDDEN))
    ) {
      console.log("ADDING RUN ID", runId);
      this.metadatas[runId] = [
        (metadata.langgraph_checkpoint_ns as string).split("NS_SEP"),
        metadata,
      ];
    }
  }

  handleChainEnd(outputs: ChainValues, runId: string) {
    // console.log("ENDING CHAIN");
    const metadata = this.metadatas[runId];
    console.log("METADATA", runId, this.metadatas, outputs);
    delete this.metadatas[runId];
    console.log(metadata);
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
