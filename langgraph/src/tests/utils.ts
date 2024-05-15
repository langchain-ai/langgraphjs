import assert from "node:assert";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  BaseChatModel,
  BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import { BaseMessage, AIMessage } from "@langchain/core/messages";
import { ChatResult } from "@langchain/core/outputs";
import { RunnableConfig } from "@langchain/core/runnables";
import { MemorySaver } from "../checkpoint/memory.js";
import { Checkpoint, CheckpointMetadata } from "../checkpoint/base.js";

export interface FakeChatModelArgs extends BaseChatModelParams {
  responses: BaseMessage[];
}

export class FakeChatModel extends BaseChatModel {
  responses: BaseMessage[];

  constructor(fields: FakeChatModelArgs) {
    super(fields);
    this.responses = fields.responses;
  }

  _combineLLMOutput() {
    return [];
  }

  _llmType(): string {
    return "fake";
  }

  async _generate(
    messages: BaseMessage[],
    options?: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    if (options?.stop?.length) {
      return {
        generations: [
          {
            message: new AIMessage(options.stop[0]),
            text: options.stop[0],
          },
        ],
      };
    }
    const response = this.responses.shift();
    const text = messages.map((m) => m.content).join("\n");
    await runManager?.handleLLMNewToken(text);
    return {
      generations: [
        {
          message: response ?? new AIMessage(text),
          text: response ? (response.content as string) : text,
        },
      ],
      llmOutput: {},
    };
  }
}

export class MemorySaverAssertImmutable extends MemorySaver {
  storageForCopies: Record<string, Record<string, string>> = {};

  constructor() {
    super();
    this.storageForCopies = {};
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.threadId;
    if (!this.storageForCopies[threadId]) {
      this.storageForCopies[threadId] = {};
    }
    // assert checkpoint hasn't been modified since last written
    const saved = await super.get(config);
    if (saved) {
      const savedTs = saved.ts;
      if (this.storageForCopies[threadId][savedTs]) {
        assert(
          JSON.stringify(saved) === this.storageForCopies[threadId][savedTs],
          "Checkpoint has been modified since last written"
        );
      }
    }
    // save a copy of the checkpoint
    this.storageForCopies[threadId][checkpoint.ts] =
      this.serde.stringify(checkpoint);

    return super.put(config, checkpoint, metadata);
  }
}
