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

    // The python test used a class here, but a decorator function is fine
    function getNode(name: string) {
      return async () => {
        // Use the state parameter to avoid unused variable warning
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
      .addConditionalEdges("2", routeToThree);

    const graph = builder.compile();

    // Test the graph execution
    const result = await graph.invoke({ items: ["0"] });

    // Match Python's assertion exactly
    expect(result).toEqual({ items: ["0", "1", "2", "2", "3"] });
  });

  /**
   * Port of test_concurrent_emit_sends from test_pregel_async_graph_structure.py
   */
  it("should handle concurrent emit sends", async () => {
    // Define the StateAnnotation for accumulating lists
    const StateAnnotation = Annotation.Root({
      items: Annotation<string[]>({
        reducer: (a, b) => a.concat(b),
        default: () => [],
      }),
    });

    // The python test used a class here, but a decorator function is fine
    function getNode(name: string) {
      return async (state: typeof StateAnnotation.State) => {
        if (Array.isArray(state.items)) {
          return { items: [name] };
        } else {
          return { items: [`${name}|${state}`] };
        }
      };
    }

    // Define the functions for routing and sending
    const sendForFun = () => {
      return [new Send("2", 1), new Send("2", 2), "3.1"];
    };

    const sendForProfit = () => {
      return [new Send("2", 3), new Send("2", 4)];
    };

    const routeToThree = (): "3" => {
      return "3";
    };

    // Create the graph with nodes and edges
    const builder = new StateGraph({ stateSchema: StateAnnotation })
      .addNode("1", getNode("1"))
      .addNode("1.1", getNode("1.1"))
      .addNode("2", getNode("2"))
      .addNode("3", getNode("3"))
      .addNode("3.1", getNode("3.1"))
      .addEdge(START, "1")
      .addEdge(START, "1.1")
      .addConditionalEdges("1", sendForFun)
      .addConditionalEdges("1.1", sendForProfit)
      .addConditionalEdges("2", routeToThree);

    const graph = builder.compile();

    // Test the graph execution
    const result = await graph.invoke({ items: ["0"] });

    // Match Python's assertion exactly
    expect(result.items).toEqual([
      "0",
      "1",
      "1.1",
      "3.1",
      "2|1",
      "2|2",
      "2|3",
      "2|4",
      "3",
    ]);
  });
});
