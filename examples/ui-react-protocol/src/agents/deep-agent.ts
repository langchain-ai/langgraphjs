import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent } from "deepagents";

import {
  draftProtocolChecklist,
  lookupProtocolCapability,
  modelName,
  reviewProtocolRisks,
} from "./shared";

const checkpointer = new MemorySaver();

export const agent = createDeepAgent({
  model: modelName,
  checkpointer,
  subagents: [
    {
      name: "protocol-researcher",
      description:
        "Explains specific parts of the protocol and maps them to UI concerns.",
      systemPrompt: `You are the protocol researcher.

Use your tool to explain the most relevant protocol capabilities for the user.
Focus on sessions, subscriptions, messages, lifecycle, and reconnect behavior.`,
      tools: [lookupProtocolCapability],
    },
    {
      name: "integration-planner",
      description:
        "Builds concrete frontend or server test plans for protocol exploration.",
      systemPrompt: `You are the integration planner.

Turn ambiguous requests into a short, practical checklist for testing a frontend
or server flow that uses the new protocol.`,
      tools: [draftProtocolChecklist],
    },
    {
      name: "risk-reviewer",
      description:
        "Looks for observability gaps and rough edges in the protocol UX.",
      systemPrompt: `You are the risk reviewer.

Call out the most likely failure modes, especially around missing events,
subagent visibility, reconnect handling, and noisy state snapshots.`,
      tools: [reviewProtocolRisks],
    },
  ],
  systemPrompt: `You are the protocol testbed coordinator.

When the request can be broken into research, planning, and review, launch the
protocol-researcher, integration-planner, and risk-reviewer in parallel so the
frontend can show subagent activity.

Then synthesize the subagent outputs into one clear answer that helps the user
evaluate the new protocol end to end.`,
});
