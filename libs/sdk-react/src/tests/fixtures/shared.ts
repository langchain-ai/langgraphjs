import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { ToolMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { fakeModel, tool } from "langchain";
import { z } from "zod/v4";

/**
 * FakeListChatModel subclass that keeps a stable message id across the
 * streamed token chunks of a single response (needed by message-metadata /
 * stategraph text fixtures).
 */
export class StableFakeListChatModel extends FakeListChatModel {
  private streamIndex = 0;

  async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    const response = this._currentResponse();
    this._incrementResponse();

    const streamMessageId = `stategraph-message-${this.streamIndex++}`;
    for await (const text of response) {
      const chunk = this._createResponseChunk(text);
      chunk.message.id = streamMessageId;
      chunk.message.lc_kwargs.id = streamMessageId;

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

export const createStableTextModel = (responses: string[]) =>
  new StableFakeListChatModel({
    responses,
  });

/**
 * {@link fakeModel} wrapper that replays `responses` in a loop.
 *
 * Mock-server graphs are compiled once and shared across the suite, so a
 * one-shot FIFO queue would dry up after the first test. Each slot is a
 * factory that advances a shared turn counter — see
 * https://docs.langchain.com/oss/javascript/langchain/test/unit-testing
 */
export function scriptedFakeModel(
  responses: AIMessage[],
  capacity = 512
): ReturnType<typeof fakeModel> {
  if (responses.length === 0) {
    throw new Error("scriptedFakeModel requires at least one response");
  }
  let turn = 0;
  let model = fakeModel();
  for (let i = 0; i < capacity; i++) {
    model = model.respond(() => {
      const message = responses[turn % responses.length]!;
      turn += 1;
      return message;
    });
  }
  return model;
}

/**
 * Scripted tool-calling model for Node-side graph fixtures.
 */
export function createDeterministicToolCallingModel(options: {
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  finalText: string;
}) {
  return scriptedFakeModel([
    new AIMessage({
      id: `${options.toolCallId}-message`,
      content: "",
      tool_calls: [
        {
          id: options.toolCallId,
          name: options.toolName,
          args: options.toolArgs,
          type: "tool_call",
        },
      ],
    }),
    new AIMessage({
      id: `${options.toolCallId}-final`,
      content: options.finalText,
    }),
  ]);
}

export const searchWebTool = tool(
  async ({ query }: { query: string }) =>
    JSON.stringify({
      status: "success",
      query,
      results: [
        { title: `Result for: ${query}`, url: "https://example.com/1" },
        { title: `More on: ${query}`, url: "https://example.com/2" },
      ],
    }),
  {
    name: "search_web",
    description: "Search the web for information on a topic",
    schema: z.object({
      query: z.string(),
    }),
  }
);

export const queryDatabaseTool = tool(
  async ({ table }: { table: string }, config) => {
    const content = JSON.stringify({
      status: "success",
      table,
      records: [
        { id: 1, name: "Record A", value: 42 },
        { id: 2, name: "Record B", value: 87 },
      ],
      count: 2,
    });

    return new Command({
      update: {
        messages: [
          new ToolMessage({
            content,
            tool_call_id: config.toolCall?.id as string,
            name: "query_database",
          }),
        ],
      },
    });
  },
  {
    name: "query_database",
    description: "Query a database table with optional filters",
    schema: z.object({
      table: z.string(),
    }),
  }
);

export const deepOrchestratorModel = scriptedFakeModel([
  new AIMessage({
    id: "deep-orchestrator-tool-call",
    content: "",
    tool_calls: [
      {
        name: "task",
        args: {
          description: "Search the web for protocol risks",
          subagent_type: "researcher",
        },
        id: "task-1",
        type: "tool_call",
      },
      {
        name: "task",
        args: {
          description: "Inspect the sample dataset",
          subagent_type: "data-analyst",
        },
        id: "task-2",
        type: "tool_call",
      },
    ],
  }),
  new AIMessage({
    id: "deep-orchestrator-final",
    content: "Both subagents completed their tasks successfully.",
  }),
]);

export const deepResearcherModel = createDeterministicToolCallingModel({
  toolCallId: "search-1",
  toolName: "search_web",
  toolArgs: { query: "protocol risks" },
  finalText: "Research completed: reconnect and lifecycle handling need coverage.",
});

export const deepAnalystModel = createDeterministicToolCallingModel({
  toolCallId: "query-1",
  toolName: "query_database",
  toolArgs: { table: "sample_data" },
  finalText: "Analysis completed: found 2 sample records.",
});
