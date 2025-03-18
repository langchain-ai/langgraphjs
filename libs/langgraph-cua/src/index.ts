import { END, START, StateGraph } from "@langchain/langgraph";
import { callModel } from "./nodes/call-model.js";
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
 * Routes to the callModel node if a computer call output is present,
 * otherwise routes to END.
 *
 * @param {CUAState} state The current state of the thread.
 * @returns {"callModel" | typeof END} The next node to execute.
 */
function reinvokeModelOrEnd(state: CUAState): "callModel" | typeof END {
  if (state.computerCallOutput) {
    return "callModel";
  }

  return END;
}

const workflow = new StateGraph(CUAAnnotation, CUAConfigurable)
  .addNode("callModel", callModel)
  .addNode("takeComputerAction", takeComputerAction)
  .addEdge(START, "callModel")
  .addConditionalEdges("callModel", takeActionOrEnd, [
    "takeComputerAction",
    END,
  ])
  .addConditionalEdges("takeComputerAction", reinvokeModelOrEnd, [
    "callModel",
    END,
  ]);

export const graph = workflow.compile();
graph.name = "Computer Use Agent";
