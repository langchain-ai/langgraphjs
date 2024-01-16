import { AgentStep, AgentAction, AgentFinish } from "@langchain/core/agents";

// Define the data type that the agent will return.
type AgentData = {
  input: string;
  steps: Array<AgentStep>;
  agentOutcome?: AgentAction | AgentFinish;
};

const firstAgent = (inputs: AgentData) => {
  const newInputs = inputs;
  const action = {
    tool: "tavily_search_results_json",
    toolInput: newInputs.input,
    log: ""
  };
  newInputs.agentOutcome = action;
  return newInputs;
};
