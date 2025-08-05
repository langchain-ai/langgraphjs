import { StateGraph, Annotation } from "@langchain/langgraph";

export const graph = async (config: {
  configurable?: { nodeName: string };
}) => {
  const node = config.configurable?.nodeName ?? "default";

  const state = Annotation.Root({
    node: Annotation<string>,
    messages: Annotation<string[]>({
      default: () => [],
      reducer: (a: string[], b: string[] | string) => {
        if (Array.isArray(b)) return [...a, ...b];
        return [...a, b];
      },
    }),
  });

  return new StateGraph(state)
    .addNode(node, () => ({ node, messages: [node] }))
    .addEdge("__start__", node)
    .addEdge(node, "__end__")
    .compile();
};
