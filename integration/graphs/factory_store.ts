import {
  Annotation,
  LangGraphRunnableConfig,
  START,
  StateGraph,
} from "@langchain/langgraph";

const FACTORY_NAMESPACE = ["factory-store-seeded"];

const State = Annotation.Root({
  seededUserId: Annotation<string | null>,
  hasFactoryCheckpointer: Annotation<boolean>,
});

type FactoryConfig = LangGraphRunnableConfig & {
  checkpointer?: unknown;
};

export async function graph(config: FactoryConfig) {
  if (!config.store) {
    throw new Error("Expected platform store in graph factory");
  }
  if (!config.checkpointer) {
    throw new Error("Expected platform checkpointer in graph factory");
  }

  const userId = String(config.configurable?.user_id ?? "default-user");
  const hasFactoryCheckpointer = Boolean(config.checkpointer);
  await config.store.put(FACTORY_NAMESPACE, userId, { userId });

  return new StateGraph(State)
    .addNode(
      "read_factory_seed",
      async (_, nodeConfig: LangGraphRunnableConfig) => {
        const seeded = await nodeConfig.store?.get(FACTORY_NAMESPACE, userId);
        return {
          seededUserId: (seeded?.value?.userId as string | null) ?? null,
          hasFactoryCheckpointer,
        };
      }
    )
    .addEdge(START, "read_factory_seed")
    .addEdge("read_factory_seed", "__end__")
    .compile();
}
