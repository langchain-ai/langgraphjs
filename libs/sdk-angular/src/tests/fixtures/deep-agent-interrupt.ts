import { AIMessage } from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";
import { createDeepAgent, type DeepAgent } from "deepagents";
import { fakeModel, tool } from "langchain";
import { z } from "zod/v4";

/**
 * {@link fakeModel} that replays responses in a loop so the shared
 * mock-server graph survives multiple suite tests.
 */
function scriptedFakeModel(responses: AIMessage[], capacity = 512) {
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

const orchestratorModel = scriptedFakeModel([
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
]);

const approverModel = scriptedFakeModel([
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
]);

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
