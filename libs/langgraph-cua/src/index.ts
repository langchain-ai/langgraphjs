import { END, START, StateGraph } from "@langchain/langgraph";
import { callModel } from "./nodes/call-model.js";
import { createVMInstance } from "./nodes/create-vm-instance.js";
import { takeComputerAction } from "./nodes/take-computer-action.js";
import { CUAState, CUAAnnotation, CUAConfigurable } from "./types.js";
import { isComputerToolCall } from "./utils.js";

/**
 * Routes to the takeComputerAction node if a computer call is present
 * in the last message, otherwise routes to END.
 *
 * @param {CUAState} state The current state of the thread.
 * @returns {"takeComputerAction" | typeof END} The next node to execute.
 */
function takeActionOrEnd(state: CUAState): "takeComputerAction" | typeof END {
  const lastMessage = state.messages[state.messages.length - 1];
  if (
    !lastMessage ||
    !isComputerToolCall(lastMessage.additional_kwargs?.tool_outputs)
  ) {
    return END;
  }
  return "takeComputerAction";
}

/**
 * Routes to the takeComputerAction node if no instance ID exists, otherwise
 * routes to takeActionOrEnd.
 *
 * @param {CUAState} state The current state of the thread.
 * @returns {"takeComputerAction" | typeof END | "createVMInstance"} The next node to execute.
 */
function routeAfterCallingModel(
  state: CUAState
): "takeComputerAction" | typeof END | "createVMInstance" {
  if (!state.instanceId) {
    return "createVMInstance";
  }

  return takeActionOrEnd(state);
}

/**
 * Routes to the callModel node if a computer call output is present,
 * otherwise routes to END.
 *
 * @param {CUAState} state The current state of the thread.
 * @returns {"callModel" | typeof END} The next node to execute.
 */
function reinvokeModelOrEnd(state: CUAState): "callModel" | typeof END {
  const lastMsg = state.messages[state.messages.length - 1];
  if (
    lastMsg.getType() === "tool" &&
    "type" in lastMsg.additional_kwargs &&
    lastMsg.additional_kwargs.type === "computer_call_output"
  ) {
    return "callModel";
  }
  return END;
}

const workflow = new StateGraph(CUAAnnotation, CUAConfigurable)
  .addNode("callModel", callModel)
  .addNode("createVMInstance", createVMInstance)
  .addNode("takeComputerAction", takeComputerAction)
  .addEdge(START, "callModel")
  .addConditionalEdges("callModel", routeAfterCallingModel, [
    "createVMInstance",
    "takeComputerAction",
    END,
  ])
  .addEdge("createVMInstance", "takeComputerAction")
  .addConditionalEdges("takeComputerAction", reinvokeModelOrEnd, [
    "callModel",
    END,
  ]);

export const graph = workflow.compile();
graph.name = "Computer Use Agent";
