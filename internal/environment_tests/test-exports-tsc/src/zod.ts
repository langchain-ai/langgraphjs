import { END, START, StateGraph } from "@langchain/langgraph/web";
import { HumanMessage } from "@langchain/core/messages";
import { Tool } from "@langchain/core/tools";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { z } from "zod";
import { withLangGraph } from "@langchain/langgraph/zod";

// Test withLangGraph
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
    return "Not too cold, not too hot 😎";
  }
}

// Zod schema test
const WeatherSchema = z.object({
  temperature: z.number(),
  condition: z.string(),
  location: z.string(),
});
type Weather = z.infer<typeof WeatherSchema>;

const WeatherGraphState = z.object({
  messages: z.array(z.any()),
  weather: withLangGraph(WeatherSchema, {
    default: () => ({ temperature: 0, condition: "unknown", location: "" }),
    reducer: {
      fn: (_: Weather, b: Weather): Weather => b,
    },
  }),
});

type WeatherGraphStateType = z.infer<typeof WeatherGraphState>;

const weatherGraph = new StateGraph(WeatherGraphState)
  .addNode("get_weather", async (state: WeatherGraphStateType) => {
    return {
      weather: {
        temperature: 72,
        condition: "sunny",
        location: "San Francisco",
      },
    };
  })
  .addEdge(START, "get_weather")
  .addEdge("get_weather", END);

const compiledWeatherGraph = weatherGraph.compile();
const weatherGraphResult = await compiledWeatherGraph.invoke({
  messages: [new HumanMessage("What's the weather?")],
});
console.log("Zod schema test result:", weatherGraphResult);

export const COMPILED_WEATHER_GRAPH = compiledWeatherGraph;
