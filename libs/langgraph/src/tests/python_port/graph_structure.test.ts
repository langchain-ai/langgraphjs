import { describe, it, expect } from "@jest/globals";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { StateGraph } from "../../graph/state.js";
import { Annotation, START } from "../../web.js";
import { Send, Command, isCommand, INTERRUPT } from "../../constants.js";
import { task, entrypoint } from "../../func/index.js";
import { interrupt } from "../../interrupt.js";
import { gatherIterator } from "../../utils.js";
import { FakeTracer } from "../utils.js";
import { initializeAsyncLocalStorageSingleton } from "../../setup/async_local_storage.js";

beforeAll(() => {
  // Will occur naturally if user imports from main `@langchain/langgraph` endpoint.
  initializeAsyncLocalStorageSingleton();
});

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
            : {
                items: [
                  `${name}|${JSON.stringify(
                    isCommand(state) ? state.toJSON() : state
                  )}`,
                ],
              };

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

  /**
   * Port of test_imp_task from test_pregel_async_graph_structure.py
   */
  it("should handle imperative task API", async () => {
    let mapperCallCount = 0;

    // Define a mapper task similar to the Python version
    const mapper = task("mapper", async (input: number): Promise<string> => {
      mapperCallCount += 1;
      // Simulate the delay with setTimeout instead of asyncio.sleep
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100 * input);
      });
      return String(input).repeat(2);
    });

    // Create a graph using entrypoint
    const graph = entrypoint(
      { name: "graph", checkpointer: new MemorySaver() },
      async (input: number[]): Promise<string[]> => {
        // Map the input values in parallel using the mapper task
        const futures = input.map((i) => mapper(i));
        const mapped = await Promise.all(futures);

        // Use interrupt function to ask a question
        const answer = interrupt("question");

        // Append the answer to each mapped result
        return mapped.map((m: string) => m + answer);
      }
    );

    // Create a tracer to track the execution
    const tracer = new FakeTracer();
    const thread1 = { configurable: { thread_id: "1" }, callbacks: [tracer] };

    // Gather the streaming results from the graph
    const results = await gatherIterator(await graph.stream([0, 1], thread1));

    // Validate the streaming outputs
    expect(results).toEqual([
      { mapper: "00" },
      { mapper: "11" },
      {
        [INTERRUPT]: [
          {
            value: "question",
            resumable: true,
            ns: expect.arrayContaining([expect.stringMatching(/^graph:/)]),
            when: "during",
          },
        ],
      },
    ]);

    // Check that the mapper was called exactly twice
    expect(mapperCallCount).toBe(2);

    // Validate tracer runs
    expect(tracer.runs.length).toBe(1);

    // Check for the entrypoint run
    const entrypointRun = tracer.runs[0].child_runs[0];
    expect(entrypointRun).toBeDefined();
    expect(entrypointRun.name).toBe("graph");

    // Check for the mapper runs
    const mapperRuns = tracer.runs[0].child_runs.filter(
      (run: { name: string }) => run.name === "mapper"
    );
    expect(mapperRuns.length).toBe(2);

    // Check that the mapper inputs cover both input values
    expect(
      mapperRuns.some(
        (run: { inputs: Record<string, unknown> }) =>
          Array.isArray(run.inputs.input) &&
          run.inputs.input.length === 1 &&
          run.inputs.input[0] === 0
      )
    ).toBe(true);

    expect(
      mapperRuns.some(
        (run: { inputs: Record<string, unknown> }) =>
          Array.isArray(run.inputs.input) &&
          run.inputs.input.length === 1 &&
          run.inputs.input[0] === 1
      )
    ).toBe(true);

    // Resume the graph with an answer
    const finalResult = await graph.invoke(
      new Command({ resume: "answer" }),
      thread1
    );

    // Verify the final result contains the expected values
    expect(finalResult).toEqual(["00answer", "11answer"]);

    // Verify the mapper wasn't called again
    expect(mapperCallCount).toBe(2);
  });
});
