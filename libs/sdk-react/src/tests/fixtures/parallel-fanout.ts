import { AIMessage } from "@langchain/core/messages";
import { createDeepAgent, type DeepAgent } from "deepagents";

import { DeterministicToolCallingModel, createStableTextModel } from "./shared.js";
import { FANOUT_WORKER_COUNT } from "./parallel-constants.js";

export { FANOUT_WORKER_COUNT };

/**
 * Orchestrator that dispatches {@link FANOUT_WORKER_COUNT} parallel
 * `task` tool calls in a single turn, each with a distinct
 * `description` so every worker gets a unique `taskInput` (drives the
 * subagent namespace binding / FIFO de-dup), then a final summary turn.
 */
const orchestratorModel = new DeterministicToolCallingModel({
  responses: [
    new AIMessage({
      id: "fanout-orchestrator",
      content: "",
      tool_calls: Array.from({ length: FANOUT_WORKER_COUNT }, (_, i) => {
        const label = `worker-${String(i + 1).padStart(3, "0")}`;
        return {
          id: `task-${i + 1}`,
          name: "task",
          args: {
            description: `Worker ${label} covering topic ${i + 1}`,
            subagent_type: "worker",
          },
          type: "tool_call" as const,
        };
      }),
    }),
    new AIMessage({
      id: "fanout-final",
      content: "All workers completed.",
    }),
  ],
});

/** Each worker subagent deterministically replies with a single text turn. */
const workerModel = createStableTextModel(
  Array.from({ length: FANOUT_WORKER_COUNT }, (_, i) => `Worker ${i + 1} done.`)
);

export const graph = createDeepAgent({
  model: orchestratorModel,
  subagents: [
    {
      name: "worker",
      description: "A worker that completes a single delegated subtask.",
      systemPrompt: "You are a worker. Complete the task and report back.",
      tools: [],
      model: workerModel,
    },
  ],
  systemPrompt: "You are a coordinator that fans out work to many workers.",
}) as DeepAgent;
