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
 * @returns {"takeComputerAction" | typeof END | "createVMInstance"} The next node to execute.
 */
function takeActionOrEnd(
  state: CUAState
): "takeComputerAction" | "createVMInstance" | typeof END {
  const lastMessage = state.messages[state.messages.length - 1];
  if (
    !lastMessage ||
    !isComputerToolCall(lastMessage.additional_kwargs?.tool_outputs)
  ) {
    return END;
  }

  if (!state.instanceId) {
    return "createVMInstance";
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
  .addConditionalEdges("callModel", takeActionOrEnd, [
    "createVMInstance",
    "takeComputerAction",
    END,
  ])
  .addEdge("createVMInstance", "takeComputerAction")
  .addConditionalEdges("takeComputerAction", reinvokeModelOrEnd, [
    "callModel",
    END,
  ]);

export const cuaGraph = workflow.compile();
cuaGraph.name = "Computer Use Agent";

/**
 * Configuration for the Computer Use Agent.
 *
 * @param options - Configuration options
 * @param options.scrapybaraApiKey - The API key to use for Scrapybara.
 *        This can be provided in the configuration, or set as an environment variable (SCRAPYBARA_API_KEY).
 * @param options.timeoutHours - The number of hours to keep the virtual machine running before it times out.
 *        Must be between 0.01 and 24. Default is 1.
 * @param options.zdrEnabled - Whether or not Zero Data Retention is enabled in the user's OpenAI account. If true,
 *        the agent will not pass the 'previous_response_id' to the model, and will always pass it the full
 *        message history for each request. If false, the agent will pass the 'previous_response_id' to the
 *        model, and only the latest message in the history will be passed. Default false.
 * @param options.recursionLimit - The maximum number of recursive calls the agent can make. Default is 100.
 * @param options.authStateId - The ID of the authentication state. If defined, it will be used to authenticate
 *        with Scrapybara. Only applies if 'environment' is set to 'web'.
 * @param options.environment - The environment to use. Default is "web".
 * @returns The configured graph.
 */
export function createCua({
  scrapybaraApiKey,
  timeoutHours = 1.0,
  zdrEnabled = false,
  recursionLimit = 100,
  authStateId,
  environment = "web",
}: {
  scrapybaraApiKey?: string;
  timeoutHours?: number;
  zdrEnabled?: boolean;
  recursionLimit?: number;
  authStateId?: string;
  environment?: "web" | "ubuntu" | "windows";
} = {}) {
  // Validate timeout_hours is within acceptable range
  if (timeoutHours < 0.01 || timeoutHours > 24) {
    throw new Error("timeoutHours must be between 0.01 and 24");
  }

  // Configure the graph with the provided parameters
  const configuredGraph = cuaGraph.withConfig({
    configurable: {
      scrapybaraApiKey,
      timeoutHours,
      zdrEnabled,
      authStateId,
      environment,
    },
    recursionLimit,
  });

  return configuredGraph;
}
