import { AgentAction, AgentFinish } from "@langchain/core/agents";
import { BaseMessage } from "@langchain/core/messages";
import { Runnable, RunnableLambda } from "@langchain/core/runnables";
import { Tool } from "@langchain/core/tools";
import { ToolExecutor } from "./tool_executor.js";
import { StateGraph, StateGraphArgs } from "../graph/state.js";
import { END } from "../index.js";
import { Pregel } from "../pregel/index.js";

interface AgentStateBase {
  agentOutcome?: AgentAction | AgentFinish;
  steps: Array<[AgentAction, string]>;
}

interface AgentState extends AgentStateBase {
  input: string;
  chatHistory?: BaseMessage[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentChannels<T> = StateGraphArgs<Array<any> | T>["channels"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _getAgentState<T extends Array<any> = Array<any>>(
  inputSchema?: AgentChannels<T>
): AgentChannels<T> {
  if (!inputSchema) {
    return {
      input: {
        value: null
      },
      agentOutcome: {
        value: null
      },
      steps: {
        value: (x, y) => x.concat(y),
        default: () => []
      }
    };
  } else {
    return inputSchema;
  }
}

export function createAgentExecutor<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends Array<any> = Array<any>
>({
  agentRunnable,
  tools,
  inputSchema
}: {
  agentRunnable: Runnable;
  tools: Array<Tool> | ToolExecutor;
  inputSchema?: AgentChannels<T>;
}): Pregel {
  let toolExecutor: ToolExecutor;
  if (!Array.isArray(tools)) {
    toolExecutor = tools;
  } else {
    toolExecutor = new ToolExecutor({
      tools
    });
  }

  const state = _getAgentState<T>(inputSchema);

  // Define logic that will be used to determine which conditional edge to go down
  const shouldContinue = (data: AgentState) => {
    if (data.agentOutcome && "returnValues" in data.agentOutcome) {
      return "end";
    }
    return "continue";
  };

  const runAgent = async (data: AgentState) => {
    const agentOutcome = await agentRunnable.invoke(data);
    return {
      agentOutcome
    };
  };

  const executeTools = async (data: AgentState) => {
    const agentAction = data.agentOutcome;
    if (!agentAction || "returnValues" in agentAction) {
      throw new Error("Agent has not been run yet");
    }
    const output = await toolExecutor.invoke(agentAction);
    return {
      steps: [[agentAction, output]]
    };
  };

  // Define a new graph
  const workflow = new StateGraph({
    channels: state
  });

  // Define the two nodes we will cycle between
  workflow.addNode("agent", new RunnableLambda({ func: runAgent }));
  workflow.addNode("action", new RunnableLambda({ func: executeTools }));

  // Set the entrypoint as `agent`
  // This means that this node is the first one called
  workflow.setEntryPoint("agent");

  // We now add a conditional edge
  workflow.addConditionalEdges(
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
      end: END
    }
  );

  // We now add a normal edge from `tools` to `agent`.
  // This means that after `tools` is called, `agent` node is called next.
  workflow.addEdge("action", "agent");

  return workflow.compile();
}
