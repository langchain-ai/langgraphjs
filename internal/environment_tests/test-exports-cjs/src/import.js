async function test() {
  const { StateGraph, END, START } = await import("@langchain/langgraph/web");
  const { createReactAgent } = await import("@langchain/langgraph/prebuilt");
  const { HumanMessage } = await import ("@langchain/core/messages");
  const { Tool } = await import("@langchain/core/tools");
  const { FakeListChatModel } = await import("@langchain/core/utils/testing");
  // Define the graph state
  const graphState = {
    messages: {
      value: (x, y) => x.concat(y),
      default: () => [],
    },
  };
  const graph = new StateGraph({ channels: graphState })
    .addNode("test", async () => {})
    .addEdge(START, "test")
    .addEdge("test", END);
  const compiledGraph = graph.compile();
  const graphRes = await compiledGraph.invoke({ messages: [] });

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

    async _call(_) {
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
}

test()
  .then(() => console.log("success"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
