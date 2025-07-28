import { Annotation, START, StateGraph } from "@langchain/langgraph";

export const graph = new StateGraph(
  Annotation.Root({
    message: Annotation<string>(),
    model: Annotation<"openai" | "anthropic" | "unknown">(),
  }),
  Annotation.Root({ model: Annotation<"openai" | "anthropic" | "unknown">() })
)
  .addNode("use_context", (_, runtime) => ({ model: runtime.context?.model }))
  .addEdge(START, "use_context")
  .compile();
