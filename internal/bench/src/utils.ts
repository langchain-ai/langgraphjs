/* eslint-disable no-promise-executor-return, import/no-extraneous-dependencies */
import { BaseMessage } from "@langchain/core/messages";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";

import {
  BaseChatModelParams,
  BaseChatModel,
  BindToolsInput,
  BaseChatModelCallOptions,
} from "@langchain/core/language_models/chat_models";

import { ChatResult } from "@langchain/core/outputs";
import { RunnableLambda } from "@langchain/core/runnables";

import type { CompiledStateGraph } from "@langchain/langgraph";
import { randomUUID } from "crypto";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStateGraph = CompiledStateGraph<any, any, any, any, any, any>;

// Helper functions
export const runGraph = async (
  graph: AnyStateGraph,
  input: Record<string, unknown>
) => {
  const results = await gatherIterator(
    graph.stream(input, {
      configurable: { thread_id: randomUUID() },
      recursionLimit: 1000000000,
    })
  );
  return results.length;
};

export const runFirstEventLatency = async (
  graph: AnyStateGraph,
  input: Record<string, unknown>
) => {
  const iterator = await graph.stream(input, {
    configurable: { thread_id: randomUUID() },
    recursionLimit: 1000000000,
  });
  await iterator.next();
};

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
    return this.bind({
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

export async function gatherIterator<T>(
  i:
    | AsyncIterable<T>
    | Promise<AsyncIterable<T>>
    | Iterable<T>
    | Promise<Iterable<T>>
): Promise<Array<T>> {
  const out: T[] = [];
  for await (const item of await i) {
    out.push(item);
  }
  return out;
}
