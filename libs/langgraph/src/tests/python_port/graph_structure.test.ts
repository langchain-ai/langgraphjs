import { describe, it, expect } from "@jest/globals";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { StateGraph } from "../../graph/state.js";
import { Annotation, START } from "../../web.js";
import { Send, Command, isCommand } from "../../constants.js";

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

  /**
   * Port of test_send_sequences from test_pregel_async_graph_structure.py
   */
  it("should handle send sequences", async () => {
    // Define the StateAnnotation for accumulating lists
    const StateAnnotation = Annotation.Root({
      items: Annotation<string[]>({
        reducer: (a, b) => a.concat(b),
        default: () => [],
      }),
    });

    function getNode(name: string) {
      return async (state: typeof StateAnnotation.State | Command) => {
        const update =
          typeof state === "object" &&
          "items" in state &&
          Array.isArray(state.items)
            ? { items: [name] }
            : { items: [`${name}|${JSON.stringify(state)}`] };

        if (isCommand(state)) {
          return new Command({
            goto: state.goto,
            update,
          });
        } else {
          return update;
        }
      };
    }

    // Define functions for routing
    const sendForFun = () => {
      return [
        new Send("2", new Command({ goto: new Send("2", 3) })),
        new Send("2", new Command({ goto: new Send("2", 4) })),
        "3.1",
      ];
    };

    const routeToThree = (): "3" => {
      return "3";
    };

    // Create the graph with nodes and edges
    const builder = new StateGraph({ stateSchema: StateAnnotation })
      .addNode("1", getNode("1"))
      .addNode("2", getNode("2"))
      .addNode("3", getNode("3"))
      .addNode("3.1", getNode("3.1"))
      .addEdge(START, "1")
      .addConditionalEdges("1", sendForFun)
      .addConditionalEdges("2", routeToThree);

    const graph = builder.compile();

    // Test the graph execution
    const result = await graph.invoke({ items: ["0"] });

    // Match Python's assertion exactly
    expect(result.items).toEqual([
      "0",
      "1",
      "3.1",
      '2|{"goto":[{"node":"2","args":3}]}',
      '2|{"goto":[{"node":"2","args":4}]}',
      "3",
      "2|3",
      "2|4",
      "3",
    ]);

    // We're not using parametrized checkpointers in the JS version
    // but we can still test with a MemorySaver
    const checkpointer = new MemorySaver();
    const graphWithInterrupt = builder.compile({
      checkpointer,
      interruptBefore: ["3.1"],
    });

    const thread1 = { configurable: { thread_id: "1" } };

    // First invoke should stop at the interrupt
    const firstResult = await graphWithInterrupt.invoke(
      { items: ["0"] },
      thread1
    );
    expect(firstResult.items).toEqual(["0", "1"]);

    // Second invoke should complete execution from where it left off
    const secondResult = await graphWithInterrupt.invoke(null, thread1);
    expect(secondResult.items).toEqual([
      "0",
      "1",
      "3.1",
      '2|{"goto":[{"node":"2","args":3}]}',
      '2|{"goto":[{"node":"2","args":4}]}',
      "3",
      "2|3",
      "2|4",
      "3",
    ]);
  });
});
