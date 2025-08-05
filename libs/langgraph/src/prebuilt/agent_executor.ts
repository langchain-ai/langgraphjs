import { AgentAction, AgentFinish } from "@langchain/core/agents";
import { BaseMessage } from "@langchain/core/messages";
import { Runnable, type RunnableConfig } from "@langchain/core/runnables";
import { Tool } from "@langchain/core/tools";
import { ToolExecutor } from "./tool_executor.js";
import { StateGraph } from "../graph/state.js";
import { END, START } from "../constants.js";
import type { BaseChannel } from "../channels/base.js";

interface Step {
  action: AgentAction | AgentFinish;
  observation: unknown;
}

/** @ignore */
export interface AgentExecutorState {
  agentOutcome?: AgentAction | AgentFinish;
  steps: Array<Step>;
  input: string;
  chatHistory?: BaseMessage[];
}

/** @ignore */
export function createAgentExecutor({
  agentRunnable,
  tools,
}: {
  agentRunnable: Runnable;
  tools: Array<Tool> | ToolExecutor;
}) {
  let toolExecutor: ToolExecutor;
  if (!Array.isArray(tools)) {
    toolExecutor = tools;
  } else {
    toolExecutor = new ToolExecutor({
      tools,
    });
  }

  // Define logic that will be used to determine which conditional edge to go down
  const shouldContinue = (data: AgentExecutorState) => {
    if (data.agentOutcome && "returnValues" in data.agentOutcome) {
      return "end";
    }
    return "continue";
  };

  const runAgent = async (
    data: AgentExecutorState,
    config?: RunnableConfig
  ) => {
    const agentOutcome = await agentRunnable.invoke(data, config);
    return {
      agentOutcome,
    };
  };

  const executeTools = async (
    data: AgentExecutorState,
    config?: RunnableConfig
  ): Promise<Partial<AgentExecutorState>> => {
    const agentAction = data.agentOutcome;
    if (!agentAction || "returnValues" in agentAction) {
      throw new Error("Agent has not been run yet");
    }
    const output = await toolExecutor.invoke(agentAction, config);
    return {
      steps: [{ action: agentAction, observation: output }],
    };
  };

  // Define a new graph
  const workflow = new StateGraph<{
    [K in keyof AgentExecutorState]: BaseChannel<
      AgentExecutorState[K],
      AgentExecutorState[K]
    >;
  }>({
    channels: {
      input: null,
      agentOutcome: null,
      steps: {
        reducer: (x: Step[], y: Step[]) => x.concat(y),
        default: () => [] as Step[],
      },
    },
  })
    // Define the two nodes we will cycle between
    .addNode("agent", runAgent)
    .addNode("action", executeTools)
    // Set the entrypoint as `agent`
    // This means that this node is the first one called
    .addEdge(START, "agent")
    // We now add a conditional edge
    .addConditionalEdges(
      // First, we define the start node. We use `agent`.
      // This means these are the edges taken after the `agent` node is called.
      "agent",
      // Next, we pass in the function that will determine which node is called next.
      shouldContinue,
      // Finally we pass in a mapping.
      // The keys are strings, and the values are other nodes.
      // END is a special node marking that the graph should finish.
      // What will happen is we will call `should_continue`, and then the output of that
      // will be matched against the keys in this mapping.
      // Based on which one it matches, that node will then be called.
      {
        // If `tools`, then we call the tool node.
        continue: "action",
        // Otherwise we finish.
        end: END,
      }
    )
    // We now add a normal edge from `tools` to `agent`.
    // This means that after `tools` is called, `agent` node is called next.
    .addEdge("action", "agent");

  return workflow.compile();
}
