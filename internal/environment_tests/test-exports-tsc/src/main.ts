import {
  END,
  START,
  StateGraph,
  StateGraphArgs,
} from "@langchain/langgraph/web";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

import { HumanMessage } from "@langchain/core/messages";
import { Tool } from "@langchain/core/tools";
import { FakeListChatModel } from "@langchain/core/utils/testing";

// Define the graph state
const graphState: StateGraphArgs<any>["channels"] = {
  messages: {
    value: (x: HumanMessage[], y: HumanMessage[]) => x.concat(y),
    default: () => [],
  },
};
const graph = new StateGraph({ channels: graphState })
  .addNode("test", async () => {})
  .addEdge(START, "test")
  .addEdge("test", END);
const compiledGraph = graph.compile();
const graphRes = await compiledGraph.invoke({ messages: [] });
console.log(graphRes);

const weatherResponse = `Not too cold, not too hot 😎`;
const model = new FakeListChatModel({
  responses: ["test response"],
});
model.bindTools = () => model;
class SanFranciscoWeatherTool extends Tool {
  name = "current_weather";

  description = "Get the current weather report for San Francisco, CA";

  constructor() {
    super();
  }

  async _call(_: string): Promise<string> {
    return weatherResponse;
  }
}
const tools = [new SanFranciscoWeatherTool()];

const reactAgent = createReactAgent({ llm: model, tools });

const stream = await reactAgent.stream(
  {
    messages: [new HumanMessage("What's the weather like in SF?")],
  },
  { streamMode: "values" }
);
const fullResponse = [];
for await (const item of stream) {
  fullResponse.push(item);
}

export const COMPILED_GRAPH = compiledGraph;
