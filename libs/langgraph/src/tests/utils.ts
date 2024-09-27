/* eslint-disable no-promise-executor-return */
/* eslint-disable import/no-extraneous-dependencies */
import assert from "node:assert";
import { expect } from "@jest/globals";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  BaseChatModel,
  BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import {
  BaseMessage,
  AIMessage,
  HumanMessage,
  BaseMessageFields,
  AIMessageChunk,
  AIMessageFields,
  ToolMessage,
  ToolMessageFieldsWithToolCallId,
  FunctionMessage,
  FunctionMessageFieldsWithName,
} from "@langchain/core/messages";
import { ChatResult } from "@langchain/core/outputs";
import { RunnableConfig } from "@langchain/core/runnables";
import { Tool } from "@langchain/core/tools";
import {
  MemorySaver,
  Checkpoint,
  CheckpointMetadata,
} from "@langchain/langgraph-checkpoint";
import { z } from "zod";
import { BaseTracer, Run } from "@langchain/core/tracers/base";

export interface FakeChatModelArgs extends BaseChatModelParams {
  responses: BaseMessage[];
}

export class FakeChatModel extends BaseChatModel {
  responses: BaseMessage[];

  callCount = 0;

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
    const response = this.responses[this.callCount % this.responses.length];
    const text = messages.map((m) => m.content).join("\n");
    this.callCount += 1;
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

export class FakeToolCallingChatModel extends BaseChatModel {
  sleep?: number = 50;

  responses?: BaseMessage[];

  thrownErrorString?: string;

  idx: number;

  constructor(
    fields: {
      sleep?: number;
      responses?: BaseMessage[];
      thrownErrorString?: string;
    } & BaseChatModelParams
  ) {
    super(fields);
    this.sleep = fields.sleep ?? this.sleep;
    this.responses = fields.responses;
    this.thrownErrorString = fields.thrownErrorString;
    this.idx = 0;
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
    const msg = this.responses?.[this.idx] ?? messages[this.idx];
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

  bindTools(_: Tool[]) {
    return new FakeToolCallingChatModel({
      sleep: this.sleep,
      responses: this.responses,
      thrownErrorString: this.thrownErrorString,
    });
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
    const thread_id = config.configurable?.thread_id;
    if (!this.storageForCopies[thread_id]) {
      this.storageForCopies[thread_id] = {};
    }
    // assert checkpoint hasn't been modified since last written
    const saved = await super.get(config);
    if (saved) {
      const savedId = saved.id;
      if (this.storageForCopies[thread_id][savedId]) {
        assert(
          JSON.stringify(saved) === this.storageForCopies[thread_id][savedId],
          "Checkpoint has been modified since last written"
        );
      }
    }
    const [, serializedCheckpoint] = this.serde.dumpsTyped(checkpoint);
    // save a copy of the checkpoint
    this.storageForCopies[thread_id][checkpoint.id] = new TextDecoder().decode(
      serializedCheckpoint
    );

    return super.put(config, checkpoint, metadata);
  }
}

export class FakeSearchTool extends Tool {
  name = "search_api";

  description = "A simple API that returns the input string.";

  schema = z
    .object({
      input: z.string().optional(),
    })
    .transform((data) => data.input);

  constructor() {
    super();
  }

  async _call(query: string): Promise<string> {
    return `result for ${query}`;
  }
}

class AnyStringSame {
  $$typeof = Symbol.for("jest.asymmetricMatcher");

  private lastValue: string | undefined = undefined;

  private key: string;

  constructor(key: string) {
    this.key = key;
  }

  asymmetricMatch(other: unknown) {
    // eslint-disable-next-line no-instanceof/no-instanceof
    if (!(typeof other === "string" || other instanceof String)) {
      return false;
    }

    if (this.lastValue != null && this.lastValue !== other) {
      return false;
    }

    this.lastValue = other as string;
    return true;
  }

  toString() {
    return "AnyStringSame";
  }

  getExpectedType() {
    return "string";
  }

  toAsymmetricMatcher() {
    if (this.lastValue != null)
      return `AnyStringSame<${this.key}, ${this.lastValue}>`;
    return `AnyStringSame<${this.key}>`;
  }
}

export const createAnyStringSame = () => {
  const memory = new Map<string, AnyStringSame>();

  return (key: string) => {
    if (!memory.has(key)) memory.set(key, new AnyStringSame(key));
    return memory.get(key);
  };
};

export class FakeTracer extends BaseTracer {
  runs: Run[] = [];

  name = "fake_tracer";

  protected async persistRun(run: Run): Promise<void> {
    this.runs.push(run);
  }
}

export class _AnyIdHumanMessage extends HumanMessage {
  get lc_id() {
    return ["langchain_core", "messages", "HumanMessage"];
  }

  constructor(fields: BaseMessageFields | string) {
    let fieldsWithJestMatcher: Partial<BaseMessageFields> = {
      id: expect.any(String) as unknown as string,
    };
    if (typeof fields === "string") {
      fieldsWithJestMatcher = {
        content: fields,
        ...fieldsWithJestMatcher,
      };
    } else {
      fieldsWithJestMatcher = {
        ...fields,
        ...fieldsWithJestMatcher,
      };
    }
    super(fieldsWithJestMatcher as BaseMessageFields);
  }
}

export class _AnyIdAIMessage extends AIMessage {
  get lc_id() {
    return ["langchain_core", "messages", "AIMessage"];
  }

  constructor(fields: AIMessageFields | string) {
    let fieldsWithJestMatcher: Partial<AIMessageFields> = {
      id: expect.any(String) as unknown as string,
    };
    if (typeof fields === "string") {
      fieldsWithJestMatcher = {
        content: fields,
        ...fieldsWithJestMatcher,
      };
    } else {
      fieldsWithJestMatcher = {
        ...fields,
        ...fieldsWithJestMatcher,
      };
    }
    super(fieldsWithJestMatcher as AIMessageFields);
  }
}

export class _AnyIdToolMessage extends ToolMessage {
  get lc_id() {
    return ["langchain_core", "messages", "ToolMessage"];
  }

  constructor(fields: ToolMessageFieldsWithToolCallId) {
    const fieldsWithJestMatcher: Partial<ToolMessageFieldsWithToolCallId> = {
      id: expect.any(String) as unknown as string,
      ...fields,
    };
    super(fieldsWithJestMatcher as ToolMessageFieldsWithToolCallId);
  }
}

export class _AnyIdFunctionMessage extends FunctionMessage {
  get lc_id() {
    return ["langchain_core", "messages", "FunctionMessage"];
  }

  constructor(fields: FunctionMessageFieldsWithName) {
    const fieldsWithJestMatcher: Partial<FunctionMessageFieldsWithName> = {
      id: expect.any(String) as unknown as string,
      ...fields,
    };
    super(fieldsWithJestMatcher as FunctionMessageFieldsWithName);
  }
}

export class _AnyIdAIMessageChunk extends AIMessageChunk {
  get lc_id() {
    return ["langchain_core", "messages", "AIMessageChunk"];
  }

  constructor(fields: AIMessageFields | string) {
    let fieldsWithJestMatcher: Partial<AIMessageFields> = {
      id: expect.any(String) as unknown as string,
    };
    if (typeof fields === "string") {
      fieldsWithJestMatcher = {
        content: fields,
        ...fieldsWithJestMatcher,
      };
    } else {
      fieldsWithJestMatcher = {
        ...fields,
        ...fieldsWithJestMatcher,
      };
    }
    super(fieldsWithJestMatcher as AIMessageFields);
  }
}
