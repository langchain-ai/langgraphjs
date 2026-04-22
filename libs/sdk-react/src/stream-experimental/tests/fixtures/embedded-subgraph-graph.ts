import {
  AIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  MessagesAnnotation,
  START,
  StateGraph,
  type Runtime,
} from "@langchain/langgraph";

import { createStableTextModel } from "./shared.js";

const subgraphModel = createStableTextModel(["Subgraph reply"]);

/**
 * Compiled subgraph that the parent's `research` function invokes
 * directly. Its internal node is called `inner` so the namespace
 * under a host invocation looks like
 *   ["research:<uuid>", "inner:<uuid>"].
 */
const researchSubgraph = new StateGraph(MessagesAnnotation)
  .addNode(
    "inner",
    async (state: { messages: BaseMessage[] }, runtime: Runtime) => {
      runtime.writer?.({ type: "progress", label: "research-started" });
      const response = await subgraphModel.invoke(state.messages);
      runtime.writer?.({ type: "progress", label: "research-finished" });
      return { messages: [response] };
    },
  )
  .addEdge(START, "inner")
  .compile();

/**
 * Plain async function node. It IS NOT a compiled subgraph — it's a
 * function that happens to invoke one via `.invoke()`. The parent
 * graph registers the compiled subgraph with `{ subgraphs: [...] }`
 * so the checkpoint/namespace plumbing knows about it, but the
 * wire-level shape is identical to the `nested-stategraph.ts` demo:
 *
 *   ["research:<uuid>"]               ← host namespace (no direct messages)
 *   ["research:<uuid>", "inner:<uuid>"] ← subgraph's internal node
 */
async function research(state: { messages: BaseMessage[] }) {
  const result = await researchSubgraph.invoke({
    messages: state.messages,
  });
  const last = result.messages.at(-1);
  return {
    messages: [
      new AIMessage(
        typeof last?.content === "string" ? last.content : "Research done",
      ),
    ],
  };
}

/**
 * Sibling plain-function node with no subgraph invocation. Used to
 * prove that leaf function nodes do NOT appear in
 * `stream.subgraphs` — only namespaces that host a deeper execution
 * do.
 */
async function summarize(_state: { messages: BaseMessage[] }) {
  return {
    messages: [new AIMessage("Summary line")],
  };
}

const graph = new StateGraph(MessagesAnnotation)
  .addNode("research", research, { subgraphs: [researchSubgraph] })
  .addNode("summarize", summarize)
  .addEdge(START, "research")
  .addEdge("research", "summarize")
  .compile();

export { graph };
