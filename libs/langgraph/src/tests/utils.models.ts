/* eslint-disable no-promise-executor-return */
/* eslint-disable import/no-extraneous-dependencies */
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  BaseLanguageModelInput,
  BaseLanguageModelCallOptions,
  LanguageModelLike,
} from "@langchain/core/language_models/base";
import {
  BaseChatModelParams,
  BaseChatModel,
  BindToolsInput,
  BaseChatModelCallOptions,
} from "@langchain/core/language_models/chat_models";
import {
  BaseMessage,
  AIMessage,
  AIMessageChunk,
} from "@langchain/core/messages";
import { ChatResult, ChatGenerationChunk } from "@langchain/core/outputs";
import { RunnableLambda } from "@langchain/core/runnables";
import { v4 as uuidv4 } from "uuid";

export interface FakeChatModelArgs extends BaseChatModelParams {
  responses: BaseMessage[];
}

export class FakeChatModel extends BaseChatModel {
  responses: BaseMessage[];

  callCount = 0;

  streamMessageId: "omit" | "first-only" | "always";

  constructor(
    fields: FakeChatModelArgs & {
      streamMessageId?: "omit" | "first-only" | "always";
    }
  ) {
    super(fields);
    this.responses = fields.responses;
    this.streamMessageId = fields.streamMessageId ?? "omit";
  }

  _combineLLMOutput() {
    return [];
  }

  _llmType(): string {
    return "fake";
  }

  async _generate(
    messages: BaseMessage[],
    options?: this["ParsedCallOptions"]
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
    const response = this.responses[this.callCount % this.responses.length];
    const text = messages.map((m) => m.content).join("\n");
    this.callCount += 1;
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

  async *_streamResponseChunks(
    _input: BaseLanguageModelInput,
    _options?: BaseLanguageModelCallOptions,
    runManager?: CallbackManagerForLLMRun
  ) {
    const response = this.responses[this.callCount % this.responses.length];

    let isFirstChunk = true;
    const completionId = response.id ?? uuidv4();

    for (const content of (response.content as string).split("")) {
      let id: string | undefined;
      if (
        this.streamMessageId === "always" ||
        (this.streamMessageId === "first-only" && isFirstChunk)
      ) {
        id = completionId;
      }

      const chunk = new ChatGenerationChunk({
        message: new AIMessageChunk({ content, id }),
        text: content,
      });

      await runManager?.handleLLMNewToken(
        content,
        undefined,
        undefined,
        undefined,
        undefined,
        { chunk }
      );

      // TODO: workaround for the issue found in Node 18.x
      // where @langchain/core/utils/stream AsyncGeneratorWithSetup
      // does for some reason not yield the first chunk to the consumer
      // and instead the LLM token callback is seen first.
      yield chunk;

      isFirstChunk = false;
    }
    this.callCount += 1;
  }
}

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
    const serverTools = [];
    for (const tool of tools) {
      if (!("name" in tool)) {
        serverTools.push(tool);
        continue;
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
      tools: [...toolsToBind, ...serverTools],
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

export class FakeConfigurableModel extends BaseChatModel {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _queuedMethodOperations: Record<string, any> = {};

  _chatModel: LanguageModelLike;

  constructor(
    fields: {
      model: LanguageModelLike;
    } & BaseChatModelParams
  ) {
    super(fields);
    this._chatModel = fields.model;
  }

  _llmType() {
    return "fake_configurable";
  }

  async _generate(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    throw new Error("Not implemented");
  }

  async _model() {
    return this._chatModel;
  }

  bindTools(tools: BindToolsInput[]) {
    const modelWithTools = new FakeConfigurableModel({
      model: (this._chatModel as FakeToolCallingChatModel).bindTools(tools),
    });
    modelWithTools._queuedMethodOperations.bindTools = tools;
    return modelWithTools;
  }
}
