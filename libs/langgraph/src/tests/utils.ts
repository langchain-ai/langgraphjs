/* eslint-disable no-promise-executor-return */
/* eslint-disable import/no-extraneous-dependencies */
import assert from "node:assert";
import { expect, it } from "@jest/globals";
import { v4 as uuidv4 } from "uuid";
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
import { ChatGenerationChunk, ChatResult } from "@langchain/core/outputs";
import { RunnableConfig } from "@langchain/core/runnables";
import { Tool } from "@langchain/core/tools";
import {
  MemorySaver,
  Checkpoint,
  CheckpointMetadata,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";
import { z } from "zod";
import { BaseTracer, Run } from "@langchain/core/tracers/base";
import {
  BaseLanguageModelCallOptions,
  BaseLanguageModelInput,
} from "@langchain/core/language_models/base";
import { Pregel, PregelInputType, PregelOutputType } from "../pregel/index.js";
import { StrRecord } from "../pregel/algo.js";
import { PregelNode } from "../pregel/read.js";
import {
  BaseChannel,
  LangGraphRunnableConfig,
  ManagedValueSpec,
} from "../web.js";

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

      yield chunk;
      await runManager?.handleLLMNewToken(
        content,
        undefined,
        undefined,
        undefined,
        undefined,
        { chunk }
      );

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
  storageForCopies: Record<string, Record<string, Uint8Array>> = {};

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
        const loaded = await this.serde.loadsTyped(
          "json",
          this.storageForCopies[thread_id][savedId]
        );
        assert(
          JSON.stringify(saved) === JSON.stringify(loaded),
          "Checkpoint has been modified since last written"
        );
      }
    }
    const [, serializedCheckpoint] = this.serde.dumpsTyped(checkpoint);
    // save a copy of the checkpoint
    this.storageForCopies[thread_id][checkpoint.id] = serializedCheckpoint;

    return super.put(config, checkpoint, metadata);
  }
}

export class MemorySaverAssertImmutableSlow extends MemorySaverAssertImmutable {
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return super.put(config, checkpoint, metadata);
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return super.putWrites(config, writes, taskId);
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

export function skipIf(condition: () => boolean): typeof it | typeof it.skip {
  if (condition()) {
    return it.skip;
  } else {
    return it;
  }
}

export async function dumpDebugStream<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel | ManagedValueSpec>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ConfigurableFieldType extends Record<string, any> = StrRecord<string, any>,
  InputType = PregelInputType,
  OutputType = PregelOutputType
>(
  graph: Pregel<Nn, Cc, ConfigurableFieldType, InputType, OutputType>,
  input: InputType,
  config: LangGraphRunnableConfig<ConfigurableFieldType>
) {
  console.log(`invoking ${graph.name} with arguments ${JSON.stringify(input)}`);
  const stream = await graph.stream(input, {
    ...config,
    streamMode: ["updates", "debug", "values"],
  });

  let lastStep = 0;
  let lastCheckpointRef: {
    checkpoint_id: string;
    checkpoint_ns: string;
    thread_id: string;
  } = { checkpoint_id: "", checkpoint_ns: "", thread_id: "" };

  let invokeReturnValue;

  for await (const value of stream) {
    if (value[1] === "updates") {
      invokeReturnValue = value[2].payload;
      continue;
    }

    if (value[1] === "values") {
      const vals = value[2];
      console.log(
        `step ${lastStep} finished with state ${JSON.stringify(vals, null, 2)}`
      );
      console.log();
    }

    if (value[1] === "debug") {
      const { type, step, /* timestamp, */ payload } = value[2];

      if (value[2].type === "checkpoint") {
        const { configurable } = value[2].payload.config;
        lastCheckpointRef = configurable;
        continue;
      }

      lastStep = step;

      if (type === "task") {
        const { /* id, */ name, input, triggers /* interrupts */ } = payload;
        console.log(
          `step ${step}: starting ${name} triggered by ${JSON.stringify(
            triggers
          )} with inputs ${JSON.stringify(input)}`
        );
      }
      if (type === "task_result") {
        const { /* id , */ name, result /* interrupts */ } = payload;
        console.log(
          `step ${step}: task ${name} returned ${JSON.stringify(result)}`
        );
      }
    }
  }

  console.log(
    `graph execution finished - returned: ${JSON.stringify(
      invokeReturnValue,
      null,
      2
    )}`
  );

  const graphState = await graph.getState({
    configurable: lastCheckpointRef,
  });

  console.log();
  console.log(`final state: ${JSON.stringify(graphState.values, null, 2)}`);
  return invokeReturnValue as ReturnType<typeof graph.invoke>;
}
