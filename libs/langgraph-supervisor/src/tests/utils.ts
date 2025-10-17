/* eslint-disable no-promise-executor-return */
/* eslint-disable import/no-extraneous-dependencies */
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  BaseChatModel,
  BaseChatModelParams,
  BaseChatModelCallOptions,
  BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import { BaseMessage } from "@langchain/core/messages";
import { ChatResult } from "@langchain/core/outputs";
import { RunnableLambda } from "@langchain/core/runnables";

export class FakeToolCallingChatModel extends BaseChatModel {
  sleep?: number = 50;

  responses?: BaseMessage[];

  thrownErrorString?: string;

  idx: number;

  toolStyle: "openai" | "anthropic" | "bedrock" | "google" = "openai";

  structuredResponse?: Record<string, unknown>;

  // Track messages passed to structured output calls
  structuredOutputMessages: BaseMessage[][] = [];

  constructor(
    fields: {
      sleep?: number;
      responses?: BaseMessage[];
      thrownErrorString?: string;
      toolStyle?: "openai" | "anthropic" | "bedrock" | "google";
      structuredResponse?: Record<string, unknown>;
    } & BaseChatModelParams
  ) {
    super(fields);
    this.sleep = fields.sleep ?? this.sleep;
    this.responses = fields.responses;
    this.thrownErrorString = fields.thrownErrorString;
    this.idx = 0;
    this.toolStyle = fields.toolStyle ?? this.toolStyle;
    this.structuredResponse = fields.structuredResponse;
    this.structuredOutputMessages = [];
  }

  _llmType() {
    return "fake";
  }

  async _generate(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    if (this.thrownErrorString) {
      throw new Error(this.thrownErrorString);
    }
    if (this.sleep !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, this.sleep));
    }
    const responses = this.responses?.length ? this.responses : messages;
    const msg = responses[this.idx % responses.length];
    const generation: ChatResult = {
      generations: [
        {
          text: "",
          message: msg,
        },
      ],
    };
    this.idx += 1;

    if (typeof msg.content === "string") {
      await runManager?.handleLLMNewToken(msg.content);
    }
    return generation;
  }

  bindTools(tools: BindToolsInput[]) {
    const toolDicts = [];
    for (const tool of tools) {
      if (!("name" in tool)) {
        throw new TypeError(
          "Only tools with a name property are supported by FakeToolCallingModel.bindTools"
        );
      }

      // NOTE: this is a simplified tool spec for testing purposes only
      if (this.toolStyle === "openai") {
        toolDicts.push({
          type: "function",
          function: {
            name: tool.name,
          },
        });
      } else if (["anthropic", "google"].includes(this.toolStyle)) {
        toolDicts.push({
          name: tool.name,
        });
      } else if (this.toolStyle === "bedrock") {
        toolDicts.push({
          toolSpec: {
            name: tool.name,
          },
        });
      }
    }
    let toolsToBind: BindToolsInput[] = toolDicts;
    if (this.toolStyle === "google") {
      toolsToBind = [{ functionDeclarations: toolDicts }];
    }
    return this.withConfig({
      tools: toolsToBind,
    } as BaseChatModelCallOptions);
  }

  withStructuredOutput<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunOutput extends Record<string, any> = Record<string, any>
  >(_: unknown) {
    if (!this.structuredResponse) {
      throw new Error("No structured response provided");
    }
    // Create a runnable that returns the proper structured format
    return RunnableLambda.from(async (messages: BaseMessage[]) => {
      if (this.sleep) {
        await new Promise((resolve) => setTimeout(resolve, this.sleep));
      }

      // Store the messages that were sent to generate structured output
      this.structuredOutputMessages.push([...messages]);

      // Return in the format expected: { raw: BaseMessage, parsed: RunOutput }
      return this.structuredResponse as RunOutput;
    });
  }
}
