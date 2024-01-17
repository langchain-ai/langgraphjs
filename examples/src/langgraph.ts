import { pull } from "langchain/hub";
import { createOpenAIFunctionsAgent } from "langchain/agents";
import { ChatOpenAI } from "@langchain/openai";
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnablePassthrough } from "@langchain/core/runnables";
import { AgentAction, AgentFinish, AgentStep } from "@langchain/core/agents";
import { Tool } from "@langchain/core/tools";
import { END, Graph } from "../../langgraph/src/index.js";

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

// Define the agent
// Note that here, we are using `.assign` to add the output of the agent to the object
// This object will be returned from the node
// The reason we don't want to return just the result of `agentRunnable` from this node is
// that we want to continue passing around all the other inputs
const agent = RunnablePassthrough.assign({
  agentOutcome: agentRunnable
});

// Define the data type that the agent will return.
type AgentData = {
  input: string;
  steps: Array<AgentStep>;
  agentOutcome?: AgentAction | AgentFinish;
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

const shouldContinue = (data: AgentData): string => {
  if (!data.agentOutcome || "returnValues" in data.agentOutcome) {
    return "exit";
  }
  return "continue";
};

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

const workflow = new Graph();

// Add the same nodes as before, plus this "firstAgent"
workflow.addNode("firstAgent", firstAgent);
workflow.addNode("agent", agent);
workflow.addNode("tools", executeTools);

// We now set the entry point to be this first agent
workflow.setEntryPoint("firstAgent");

// We define the same edges as before
workflow.addConditionalEdges("agent", shouldContinue, {
  continue: "tools",
  exit: END
});
workflow.addEdge("tools", "agent");

// We also define a new edge, from the "first agent" to the tools node
// This is so that we can call the tool
workflow.addEdge("firstAgent", "tools");

// We now compile the graph as before
const chain = workflow.compile();

console.log(await chain.invoke({
  input: "what is the weather in sf",
  steps: []
}));

/**
{
  input: 'what is the weather in sf',
  steps: [
    {
      action: [Object],
      observation: `[{"title":"Weather in San Francisco","url":"https://www.weatherapi.com/","content":"Weather in San Francisco is {'location': {'name': 'San Francisco', 'region': 'California', 'country': 'United States of America', 'lat': 37.78, 'lon': -122.42, 'tz_id': 'America/Los_Angeles', 'localtime_epoch': 1705463885, 'localtime': '2024-01-16 19:58'}, 'current': {'last_updated_epoch': 1705463100, 'last_updated': '2024-01-16 19:45', 'temp_c': 11.7, 'temp_f': 53.1, 'is_day': 0, 'condition': {'text': 'Light rain', 'icon': '//cdn.weatherapi.com/weather/64x64/night/296.png', 'code': 1183}, 'wind_mph': 6.9, 'wind_kph': 11.2, 'wind_degree': 120, 'wind_dir': 'ESE', 'pressure_mb': 1016.0, 'pressure_in': 30.01, 'precip_mm': 2.07, 'precip_in': 0.08, 'humidity': 93, 'cloud': 100, 'feelslike_c': 11.2, 'feelslike_f': 52.1, 'vis_km': 3.2, 'vis_miles': 1.0, 'uv': 1.0, 'gust_mph': 11.4, 'gust_kph': 18.4}}","score":0.98861,"raw_content":null}]`
    },
    {
      action: [Object],
      observation: `[{"title":"Weather in San Francisco","url":"https://www.weatherapi.com/","content":"Weather in San Francisco is {'location': {'name': 'San Francisco', 'region': 'California', 'country': 'United States of America', 'lat': 37.78, 'lon': -122.42, 'tz_id': 'America/Los_Angeles', 'localtime_epoch': 1705463885, 'localtime': '2024-01-16 19:58'}, 'current': {'last_updated_epoch': 1705463100, 'last_updated': '2024-01-16 19:45', 'temp_c': 11.7, 'temp_f': 53.1, 'is_day': 0, 'condition': {'text': 'Light rain', 'icon': '//cdn.weatherapi.com/weather/64x64/night/296.png', 'code': 1183}, 'wind_mph': 6.9, 'wind_kph': 11.2, 'wind_degree': 120, 'wind_dir': 'ESE', 'pressure_mb': 1016.0, 'pressure_in': 30.01, 'precip_mm': 2.07, 'precip_in': 0.08, 'humidity': 93, 'cloud': 100, 'feelslike_c': 11.2, 'feelslike_f': 52.1, 'vis_km': 3.2, 'vis_miles': 1.0, 'uv': 1.0, 'gust_mph': 11.4, 'gust_kph': 18.4}}","score":0.98599,"raw_content":null}]`
    }
  ],
  agentOutcome: {
    returnValues: {
      output: 'The current weather in San Francisco is as follows:\n' +
        '\n' +
        '- Temperature: 11.7°C (53.1°F)\n' +
        '- Condition: Light rain\n' +
        '- Wind: 6.9 mph (11.2 kph) from the ESE\n' +
        '- Humidity: 93%\n' +
        '- Cloud cover: 100%\n' +
        '- Visibility: 3.2 km (1.0 miles)\n' +
        '- Pressure: 1016.0 mb (30.01 in)\n' +
        '- Feels like: 11.2°C (52.1°F)\n' +
        '\n' +
        "Please note that weather conditions can change rapidly, so it's always a good idea to check a reliable source for the most current information if you're planning to go out."
    },
    log: 'The current weather in San Francisco is as follows:\n' +
      '\n' +
      '- Temperature: 11.7°C (53.1°F)\n' +
      '- Condition: Light rain\n' +
      '- Wind: 6.9 mph (11.2 kph) from the ESE\n' +
      '- Humidity: 93%\n' +
      '- Cloud cover: 100%\n' +
      '- Visibility: 3.2 km (1.0 miles)\n' +
      '- Pressure: 1016.0 mb (30.01 in)\n' +
      '- Feels like: 11.2°C (52.1°F)\n' +
      '\n' +
      "Please note that weather conditions can change rapidly, so it's always a good idea to check a reliable source for the most current information if you're planning to go out."
  }
}
 */