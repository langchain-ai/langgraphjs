import {
  Annotation,
  START,
  StateGraph,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";

export const reasons: unknown[] = [];

export const graph = new StateGraph(Annotation.Root({ done: Annotation<boolean> }))
  .addNode("wait", async (_state, config: LangGraphRunnableConfig) => {
    await new Promise<void>((resolve) =>
      config.signal?.addEventListener("abort", () => resolve(), { once: true })
    );
    reasons.push(config.signal?.reason);
    return { done: true };
  })
  .addEdge(START, "wait")
  .compile();
