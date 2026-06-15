import {
  Annotation,
  StateGraph,
  END,
  START,
  BaseStore,
  AsyncBatchedStore,
} from "@langchain/langgraph";
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

async function assertStoreOps(store: BaseStore) {
  const namespace = ["someSharedStateInWeatherNode", "data"];
  const key = crypto.randomUUID();

  await store.put(namespace, key, { somePayloadKey: "foo" });
  const retrieved = await store.get(namespace, key);

  if (!retrieved) throw new Error("Failed to retrieve data");
  if (retrieved.value?.somePayloadKey !== "foo") {
    throw new Error("Retrieved data does not match expected value");
  }

  const searchItems = await store.search(["someSharedStateInWeatherNode"]);
  if (searchItems.length === 0) throw new Error("No items found in search");

  // Note: we don't call listNamespaces here directly because it requires
  // a fix: https://github.com/langchain-ai/langgraphjs/pull/1788
  await store.delete(namespace, key);

  // Verify the key is deleted
  const afterDelete = await store.get(namespace, key);
  if (afterDelete !== null) {
    throw new Error("Failed to delete key from store");
  }
}

const isAsyncBatchedStore = (
  store: BaseStore
): store is AsyncBatchedStore & { store: BaseStore } => {
  return "store" in store && store.store != null;
};

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
  .addNode("weather_node", async (state, config) => {
    // Do all the store ops :)

    const store: BaseStore = config.store!;
    // Log the class / type of the store object
    if (!store) throw new Error("Store not available");
    await assertStoreOps(store);
    if (isAsyncBatchedStore(store)) await assertStoreOps(store.store);

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
    ["weather_graph", "normal_llm_node"]
  )
  .addEdge("weather_graph", END)
  .addEdge("normal_llm_node", END);

export const graph = router.compile();
