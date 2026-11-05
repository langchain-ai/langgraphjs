import { randomUUID } from "node:crypto";

import type { BaseMessage } from "@langchain/core/messages";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { ChatGenerationChunk } from "@langchain/core/outputs";
import { FakeListChatModel } from "@langchain/core/utils/testing";

/**
 * Streams `reply` one character at a time, `sleep` ms apart, under a fresh
 * message id per call. The delay gives a test time to act while a reply is
 * still streaming (stop it, reload, open a second view).
 */
export class SlowTextModel extends FakeListChatModel {
  constructor(reply: string, sleep: number) {
    super({ responses: [reply], sleep });
  }

  async *_streamResponseChunks(
    _messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    const response = this._currentResponse();
    this._incrementResponse();

    const id = `slow-text-${randomUUID()}`;
    for await (const text of response) {
      await this._sleepIfRequested();
      options?.signal?.throwIfAborted();
      const chunk = this._createResponseChunk(text);
      chunk.message.id = id;
      chunk.message.lc_kwargs.id = id;

      yield chunk;
      void runManager?.handleLLMNewToken(
        text,
        undefined,
        undefined,
        undefined,
        undefined,
        { chunk }
      );
    }
  }
}

