import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseChatModel , BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import { BaseMessage, AIMessage } from "@langchain/core/messages";
import { ChatResult } from "@langchain/core/outputs";

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
          text: response ? response.content as string : text,
        },
      ],
      llmOutput: {},
    };
  }
}