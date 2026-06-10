import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  MessagesAnnotation,
  START,
  Send,
  StateGraph,
  type Runtime,
} from "@langchain/langgraph";

import { createStableTextModel } from "./shared.js";
import { SUBGRAPH_WORKER_COUNT } from "./parallel-constants.js";

export { SUBGRAPH_WORKER_COUNT };

const workerModel = createStableTextModel(
  Array.from({ length: SUBGRAPH_WORKER_COUNT }, () => "Subgraph reply")
);

/**
 * A compiled subgraph used as a single graph node. Fanning out N
 * `Send`s to it spawns N parallel executions under distinct
 * `worker:<uuid>` host namespaces.
 */
const worker = new StateGraph(MessagesAnnotation)
  .addNode(
    "inner",
    async (state: { messages: AIMessage[] }, runtime: Runtime) => {
      runtime.writer?.({ type: "progress", label: "worker-started" });
      const response = await workerModel.invoke(state.messages);
      return { messages: [response] };
    }
  )
  .addEdge(START, "inner")
  .compile();

const graph = new StateGraph(MessagesAnnotation)
  .addNode("worker", worker, { subgraphs: [worker] })
  .addConditionalEdges(START, () =>
    Array.from(
      { length: SUBGRAPH_WORKER_COUNT },
      (_, i) =>
        new Send("worker", {
          messages: [new HumanMessage(`Subtask ${i + 1}`)],
        })
    )
  )
  .compile();

export { graph };
