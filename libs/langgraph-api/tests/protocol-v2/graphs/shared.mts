import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { ToolMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { tool } from "langchain";
import { z } from "zod/v4";

type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  type: "tool_call";
};

const splitText = (text: string) => {
  const parts = text.match(/\S+\s*/g);
  return parts && parts.length > 0 ? parts : [text];
};

const splitJson = (value: string) => {
  if (value.length < 2) return [value];
  const midpoint = Math.ceil(value.length / 2);
  return [value.slice(0, midpoint), value.slice(midpoint)];
};

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

export class DeterministicToolCallingModel extends BaseChatModel {
  responses: AIMessage[];

  callCount = 0;

  constructor(fields: { responses: AIMessage[] } & BaseChatModelParams) {
    super(fields);
    this.responses = fields.responses;
  }

  _llmType() {
    return "deterministic-tool-calling";
  }

  _combineLLMOutput() {
    return [];
  }

  private currentResponse() {
    return this.responses[this.callCount % this.responses.length];
  }

  async _generate(): Promise<ChatResult> {
    const response = this.currentResponse();
    this.callCount += 1;
    return {
      generations: [
        {
          text: typeof response.content === "string" ? response.content : "",
          message: response,
        },
      ],
    };
  }

  async *_streamResponseChunks(): AsyncGenerator<ChatGenerationChunk> {
    const response = this.currentResponse();
    const messageId =
      typeof response.id === "string"
        ? response.id
        : `deterministic-message-${this.callCount + 1}`;

    if (response.tool_calls && response.tool_calls.length > 0) {
      for (const [index, toolCall] of response.tool_calls.entries()) {
        const parts = splitJson(JSON.stringify((toolCall as ToolCall).args));
        for (const part of parts) {
          yield new ChatGenerationChunk({
            message: new AIMessageChunk({
              id: messageId,
              content: "",
              tool_call_chunks: [
                {
                  type: "tool_call_chunk",
                  id: (toolCall as ToolCall).id,
                  name: (toolCall as ToolCall).name,
                  args: part,
                  index,
                },
              ],
            }),
            text: "",
          });
        }
      }
    } else {
      const text = typeof response.content === "string" ? response.content : "";
      for (const part of splitText(text)) {
        yield new ChatGenerationChunk({
          message: new AIMessageChunk({
            id: messageId,
            content: part,
          }),
          text: part,
        });
      }
    }

    this.callCount += 1;
  }

  bindTools() {
    return this;
  }
}

export const createStableTextModel = (responses: string[]) =>
  new StableFakeListChatModel({
    responses,
  });

export const createDeterministicToolCallingModel = (options: {
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  finalText: string;
}) =>
  new DeterministicToolCallingModel({
    responses: [
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
    ],
  });

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

export const deepOrchestratorModel = new DeterministicToolCallingModel({
  responses: [
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
  ],
});

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
