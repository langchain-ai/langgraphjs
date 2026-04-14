/**
 * Approval graph: model proposes an action, human approves or rejects.
 *
 * Demonstrates the `interrupt()` / `Command({ resume })` pattern with
 * `stream_experimental()`. The graph has three nodes:
 *
 *   1. planner — model proposes an action
 *   2. approval — calls interrupt() with the proposed action
 *   3. executor — runs the approved action (or reports rejection)
 */

import { AIMessage, SystemMessage } from "@langchain/core/messages";
import {
  END,
  interrupt,
  MemorySaver,
  MessagesValue,
  ReducedValue,
  START,
  StateGraph,
  StateSchema,
} from "@langchain/langgraph";
import { z } from "zod/v4";

import { model } from "./shared.js";

const GraphState = new StateSchema({
  messages: MessagesValue,
  proposedAction: new ReducedValue(z.string().default(() => ""), {
    reducer: (_: string, next: string) => next,
  }),
  approved: new ReducedValue(z.boolean().nullable().default(() => null), {
    reducer: (_: boolean | null, next: boolean | null) => next,
  }),
});

type GraphStateType = typeof GraphState.State;

const planner = async (state: GraphStateType) => {
  const response = await model.invoke([
    new SystemMessage(
      "You are a planner. Propose a single concrete action for the user's request. " +
        "Respond with ONLY the action description, nothing else."
    ),
    ...state.messages,
  ]);
  const action =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);
  return {
    messages: [response],
    proposedAction: action,
  };
};

const approval = (_state: GraphStateType) => {
  const decision = interrupt({
    question: "Do you approve this action?",
    action: _state.proposedAction,
  }) as { approved: boolean };
  return { approved: decision.approved };
};

const executor = async (state: GraphStateType) => {
  if (state.approved) {
    const response = await model.invoke([
      new SystemMessage(
        "The user approved the action. Confirm it has been executed. " +
          "Keep your response to one sentence."
      ),
      ...state.messages,
      { role: "user", content: `Execute: ${state.proposedAction}` },
    ]);
    return { messages: [response] };
  }
  return {
    messages: [
      new AIMessage("Action was rejected by the user. No changes were made."),
    ],
  };
};

export const checkpointer = new MemorySaver();

export const graph = new StateGraph(GraphState)
  .addNode("planner", planner)
  .addNode("approval", approval)
  .addNode("executor", executor)
  .addEdge(START, "planner")
  .addEdge("planner", "approval")
  .addEdge("approval", "executor")
  .addEdge("executor", END)
  .compile({ checkpointer });
