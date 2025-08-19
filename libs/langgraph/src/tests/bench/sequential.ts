import {
  MessagesAnnotation,
  StateGraph,
  StateType,
  UpdateType,
} from "../../index.js";

/**
 * Create a sequential no-op graph consisting of many nodes.
 */
export function createSequential(numberNodes: number) {
  const builder = new StateGraph(MessagesAnnotation) as StateGraph<
    typeof MessagesAnnotation,
    StateType<typeof MessagesAnnotation.spec>,
    UpdateType<typeof MessagesAnnotation.spec>,
    string
  >;

  const noop = () => {
    // No-op function
    return {};
  };

  let prevNode = "__start__";

  for (let i = 0; i < numberNodes; i += 1) {
    const name = `node_${i}`;
    builder.addNode(name, noop);
    builder.addEdge(prevNode, name);
    prevNode = name;
  }

  builder.addEdge(prevNode, "__end__");
  return builder;
}

import { fileURLToPath } from "node:url";
import * as inspector from "node:inspector";
async function main() {
  const graph = createSequential(3000).compile();
  const input = { messages: [] }; // Empty list of messages
  const config = { recursionLimit: 20000000000 };

  const result = [];
  console.time("stream");
  for await (const chunk of await graph.stream(input, config)) {
    result.push(chunk);
  }
  console.timeEnd("stream");

  if (inspector.url()) {
    await new Promise((resolve) => setTimeout(resolve, 360_000));
  }

  return result.length;
}

if (import.meta.url.startsWith("file:")) {
  const modulePath = fileURLToPath(import.meta.url);
  if (process.argv[1] === modulePath) {
    main();
  }
}
