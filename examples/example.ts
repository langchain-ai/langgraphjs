import { AgentStep, AgentAction, AgentFinish } from "@langchain/core/agents";
import { pull } from "langchain/hub";
import { createOpenAIFunctionsAgent } from "langchain/agents";
import { ChatOpenAI } from "@langchain/openai";
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnablePassthrough } from "langchain/runnables";
import { Tool } from "langchain/tools";
import { END, Graph } from "../src/graph/index.js";

async function main() {
  const tools = [new TavilySearchResults({ maxResults: 1 })];

  // Get the prompt to use - you can modify this!
  const prompt = await pull<ChatPromptTemplate>(
    "hwchase17/openai-functions-agent"
  );

  // Choose the LLM that will drive the agent
  const llm = new ChatOpenAI({
    modelName: "gpt-4-1106-preview",
    temperature: 0
  });

  // Construct the OpenAI Functions agent
  const agentRunnable = await createOpenAIFunctionsAgent({
    llm,
    tools,
    prompt
  });
  // Define the data type that the agent will return.
  type AgentData = {
    input: string;
    steps: Array<AgentStep>;
    agentOutcome?: AgentAction | AgentFinish;
  };

  // Define the agent
  // Note that here, we are using `.assign` to add the output of the agent to the object
  // This object will be returned from the node
  // The reason we don't want to return just the result of `agentRunnable` from this node is
  // that we want to continue passing around all the other inputs
  const agent = RunnablePassthrough.assign({
    agentOutcome: agentRunnable
  });

  const firstAgent = (inputs: AgentData) => {
    const newInputs = inputs;
    const action = {
      // We force call this tool
      tool: "tavily_search_results_json",
      // We just pass in the `input` key to this tool
      toolInput: newInputs.input,
      log: ""
    };
    newInputs.agentOutcome = action;
    return newInputs;
  };

  // Define the function to execute tools
  const executeTools = async (data: AgentData) => {
    const newData = { ...data };
    if (!newData.agentOutcome || "returnValues" in newData.agentOutcome) {
      throw new Error("Can not execute tools on a finished agent");
    }
    // Get the most recent agentOutcome - this is the key added in the `agent` above
    const agentAction = newData.agentOutcome;
    delete newData.agentOutcome; // Remove the agentOutcome from data

    // Assuming 'tools' is an array of Tool, we convert it to a map for easy access
    const toolsMap: { [key: string]: Tool } = {};
    for (const tool of tools) {
      toolsMap[tool.name] = tool;
    }

    // Get the tool to use
    const toolToUse: Tool = toolsMap[agentAction.tool];

    // Call that tool on the input
    const observation = await toolToUse.invoke(agentAction.toolInput);

    // We now add in the action and the observation to the `steps` list
    // This is the list of all previous actions taken and their output
    if (!newData.steps) {
      newData.steps = [];
    }
    newData.steps.push({ action: agentAction, observation });

    return newData;
  };

  // Define logic that will be used to determine which conditional edge to go down
  const shouldContinue = (data: AgentData): string => {
    // If the agent outcome is an AgentFinish, then we return `exit` string
    // This will be used when setting up the graph to define the flow
    if (!data.agentOutcome || "returnValues" in data.agentOutcome) {
      return "exit";
    }
    // Otherwise, an AgentAction is returned
    // Here we return `continue` string
    // This will be used when setting up the graph to define the flow
    return "continue";
  };

  const workflow = new Graph();

  // Add the same nodes as before, plus this "first agent"
  workflow.addNode("firstAgent", firstAgent);
  // Add the agent node, we give it name `agent` which we will use later
  workflow.addNode("agent", agent);
  // Add the tools node, we give it name `tools` which we will use later
  workflow.addNode("tools", executeTools);

  // We now set the entry point to be this first agent
  workflow.setEntryPoint("firstAgent");

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
    continue: "tools",
    // Otherwise we finish.
    exit: END
  }
);

  //  We now add a normal edge from `tools` to `agent`.
  // This means that after `tools` is called, `agent` node is called next.
workflow.addEdge("tools", "agent");

workflow.addEdge("firstAgent", "tools");

}
