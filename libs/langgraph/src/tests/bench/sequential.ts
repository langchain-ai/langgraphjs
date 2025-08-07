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
