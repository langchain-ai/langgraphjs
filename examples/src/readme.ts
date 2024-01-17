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

// Add the agent node, we give it name `agent` which we will use later
workflow.addNode("agent", agent);
// Add the tools node, we give it name `tools` which we will use later
workflow.addNode("tools", executeTools);

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

// Finally, we compile it!
// This compiles it into a LangChain Runnable,
// meaning you can use it as you would any other runnable
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
      observation: `[{"title":"Weather in San Francisco","url":"https://www.weatherapi.com/","content":"Weather in San Francisco is {'location': {'name': 'San Francisco', 'region': 'California', 'country': 'United States of America', 'lat': 37.78, 'lon': -122.42, 'tz_id': 'America/Los_Angeles', 'localtime_epoch': 1705463367, 'localtime': '2024-01-16 19:49'}, 'current': {'last_updated_epoch': 1705463100, 'last_updated': '2024-01-16 19:45', 'temp_c': 11.7, 'temp_f': 53.1, 'is_day': 0, 'condition': {'text': 'Light rain', 'icon': '//cdn.weatherapi.com/weather/64x64/night/296.png', 'code': 1183}, 'wind_mph': 6.9, 'wind_kph': 11.2, 'wind_degree': 120, 'wind_dir': 'ESE', 'pressure_mb': 1016.0, 'pressure_in': 30.01, 'precip_mm': 2.07, 'precip_in': 0.08, 'humidity': 93, 'cloud': 100, 'feelslike_c': 11.2, 'feelslike_f': 52.1, 'vis_km': 3.2, 'vis_miles': 1.0, 'uv': 1.0, 'gust_mph': 11.4, 'gust_kph': 18.4}}","score":0.98382,"raw_content":null}]`
    }
  ],
  agentOutcome: {
    returnValues: {
      output: 'The current weather in San Francisco is as follows:\n' +
        '\n' +
        '- Temperature: 11.7°C (53.1°F)\n' +
        '- Condition: Light rain\n' +
        '- Wind: 6.9 mph (11.2 kph) from the ESE\n' +
        '- Pressure: 1016.0 mb (30.01 in)\n' +
        '- Precipitation: 2.07 mm (0.08 in)\n' +
        '- Humidity: 93%\n' +
        '- Cloud Cover: 100%\n' +
        '- Feels Like: 11.2°C (52.1°F)\n' +
        '- Visibility: 3.2 km (1.0 miles)\n' +
        '- UV Index: 1.0\n' +
        '- Gust: 11.4 mph (18.4 kph)\n' +
        '\n' +
        'Please note that this information is for the date and time of 2024-01-16 at 19:45 local time in San Francisco.'
    },
    log: 'The current weather in San Francisco is as follows:\n' +
      '\n' +
      '- Temperature: 11.7°C (53.1°F)\n' +
      '- Condition: Light rain\n' +
      '- Wind: 6.9 mph (11.2 kph) from the ESE\n' +
      '- Pressure: 1016.0 mb (30.01 in)\n' +
      '- Precipitation: 2.07 mm (0.08 in)\n' +
      '- Humidity: 93%\n' +
      '- Cloud Cover: 100%\n' +
      '- Feels Like: 11.2°C (52.1°F)\n' +
      '- Visibility: 3.2 km (1.0 miles)\n' +
      '- UV Index: 1.0\n' +
      '- Gust: 11.4 mph (18.4 kph)\n' +
      '\n' +
      'Please note that this information is for the date and time of 2024-01-16 at 19:45 local time in San Francisco.'
  }
}
 */