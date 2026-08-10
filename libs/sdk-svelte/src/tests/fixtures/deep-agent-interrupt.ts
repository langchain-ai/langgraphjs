import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { interrupt } from "@langchain/langgraph";
import { createDeepAgent, type DeepAgent } from "deepagents";
import { tool } from "langchain";
import { z } from "zod/v4";

/** Deterministic tool-calling model for Node-side fixtures only. */
class FakeToolCallingModel extends BaseChatModel {
  responses: BaseMessage[];
  callCount = 0;

  constructor(fields: { responses: BaseMessage[] } & BaseChatModelParams) {
    super(fields);
    this.responses = fields.responses;
  }

  _llmType() {
    return "fake-tool-calling";
  }

  _combineLLMOutput() {
    return [];
  }

  async _generate(): Promise<ChatResult> {
    const baseMsg = this.responses[this.callCount % this.responses.length];
    this.callCount += 1;
    return {
      generations: [
        { text: (baseMsg.content as string) || "", message: baseMsg },
      ],
    };
  }

  async *_streamResponseChunks() {
    const baseMsg = this.responses[this.callCount % this.responses.length];
    const toolCalls = (baseMsg as AIMessage).tool_calls;
    const chunkFields: Record<string, unknown> = {
      content: (baseMsg.content as string) || "",
    };
    if (toolCalls?.length) {
      chunkFields.tool_call_chunks = toolCalls.map(
        (
          tc: { name: string; args: Record<string, unknown>; id?: string },
          index: number
        ) => ({
          name: tc.name,
          args: JSON.stringify(tc.args),
          id: tc.id,
          index,
          type: "tool_call_chunk" as const,
        })
      );
    }
    yield new ChatGenerationChunk({
      message: new AIMessageChunk(chunkFields),
      text: (baseMsg.content as string) || "",
    });
    this.callCount += 1;
  }

  bindTools() {
    return this;
  }
}

const requestApprovalTool = tool(
  async () => {
    const decision = interrupt({
      prompt: "Approve subagent tool action?",
    });
    return JSON.stringify(decision ?? { approved: true });
  },
  {
    name: "request_approval",
    description: "Request human approval before proceeding.",
    schema: z.object({}),
  }
);

const orchestratorModel = new FakeToolCallingModel({
  responses: [
    new AIMessage({
      id: "deep-interrupt-orchestrator",
      content: "",
      tool_calls: [
        {
          id: "task-approve-1",
          name: "task",
          args: {
            description: "Request approval for the pending change",
            subagent_type: "approver",
          },
          type: "tool_call" as const,
        },
      ],
    }),
    new AIMessage({
      id: "deep-interrupt-final",
      content: "Subagent approval completed.",
    }),
  ],
});

const approverModel = new FakeToolCallingModel({
  responses: [
    new AIMessage({
      id: "approver-call",
      content: "",
      tool_calls: [
        {
          id: "approval-1",
          name: "request_approval",
          args: {},
          type: "tool_call" as const,
        },
      ],
    }),
    new AIMessage({
      id: "approver-done",
      content: "Approval recorded.",
    }),
  ],
});

export const graph = createDeepAgent({
  model: orchestratorModel,
  subagents: [
    {
      name: "approver",
      description: "Requests human approval before acting.",
      systemPrompt: "You must request approval before proceeding.",
      tools: [requestApprovalTool],
      model: approverModel,
    },
  ],
  systemPrompt: "Delegate approval work to the approver subagent.",
}) as DeepAgent;
