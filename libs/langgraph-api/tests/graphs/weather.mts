import { Annotation, StateGraph, END, START } from "@langchain/langgraph";
import { MessagesAnnotation } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";

const state = MessagesAnnotation;

const weatherState = Annotation.Root({
  ...state.spec,
  city: Annotation<string>,
});

const routerState = Annotation.Root({
  ...state.spec,
  route: Annotation<"weather" | "other">,
});

const weather = new StateGraph(weatherState)
  .addNode("model_node", (state) => {
    const llm = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "tool_call123",
          name: "get_weather",
          args: { city: "San Francisco" },
        },
      ],
    });

    return { city: llm.tool_calls![0].args.city };
  })
  .addNode("weather_node", async (state) => {
    const result = `It's sunny in ${state.city}!`;
    return { messages: [new AIMessage({ content: result })] };
  })
  .addEdge(START, "model_node")
  .addEdge("model_node", "weather_node")
  .addEdge("weather_node", END)
  .compile({ interruptBefore: ["weather_node"] });

const router = new StateGraph(routerState)
  .addNode("router_node", async () => ({ route: "weather" }))
  .addNode("normal_llm_node", () => ({ messages: [new AIMessage("Hello")] }))
  .addNode("weather_graph", weather)
  .addEdge(START, "router_node")
  .addConditionalEdges(
    "router_node",
    ({ route }) => {
      if (route === "weather") return "weather_graph";
      return "normal_llm_node";
    },
    ["weather_graph", "normal_llm_node"],
  )
  .addEdge("weather_graph", END)
  .addEdge("normal_llm_node", END);

export const graph = router.compile();
