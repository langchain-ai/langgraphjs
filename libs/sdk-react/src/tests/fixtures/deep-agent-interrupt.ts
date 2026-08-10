import { AIMessage } from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";
import { createDeepAgent, type DeepAgent } from "deepagents";
import { tool } from "langchain";
import { z } from "zod/v4";

import { scriptedFakeModel } from "./shared.js";

/**
 * Tool that pauses the run with `interrupt()` so the subagent's
 * tool-execution namespace emits a nested `input.requested`.
 */
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

/**
 * Orchestrator that deterministically fans out a single `task` call to
 * the `approver` subagent, then emits a final summary after resume.
 */
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

/** Subagent that immediately calls `request_approval` (which interrupts). */
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
