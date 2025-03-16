import { describe, it, expect } from "@jest/globals";
import { StateGraph } from "../../graph/state.js";
import { Annotation, START } from "../../web.js";
import { Send } from "../../constants.js";

/**
 * Port of tests from test_pregel_async_graph_structure.py
 */
describe("Graph Structure Tests (Python port)", () => {
  /**
   * Port of test_cond_edge_after_send from test_pregel_async_graph_structure.py
   */
  it("should handle conditional edges after send", async () => {
    // Define the StateAnnotation for accumulating lists
    const StateAnnotation = Annotation.Root({
      items: Annotation<string[]>({
        reducer: (a, b) => a.concat(b),
        default: () => [],
      }),
    });

    // Create Node class similar to the Python version
    function getNode(name: string) {
      return async (state: typeof StateAnnotation.State) => {
        // Use the state parameter to avoid unused variable warning
        console.log("Processing state:", state);
        return { items: [name] };
      };
    }

    // Define the functions for routing
    const sendForFun = (state: unknown) => {
      return [new Send("2", state), new Send("2", state)];
    };

    const routeToThree = (): "3" => {
      return "3";
    };

    // Create the graph with nodes and edges
    const builder = new StateGraph({ stateSchema: StateAnnotation })
      .addNode("1", getNode("1"))
      .addNode("2", getNode("2"))
      .addNode("3", getNode("3"))
      .addEdge(START, "1")
      .addConditionalEdges("1", sendForFun)
      .addConditionalEdges("2", routeToThree)
      .addEdge("3", "__end__");

    const graph = builder.compile();

    // Test the graph execution
    const result = await graph.invoke({ items: ["0"] });

    // Match Python's assertion exactly
    expect(result).toEqual({ items: ["0", "1", "2", "2", "3"] });
  });
});
