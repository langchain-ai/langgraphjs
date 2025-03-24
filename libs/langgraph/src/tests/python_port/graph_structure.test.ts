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
        return mapped.map((m: string) => `${m}${answer}`);
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

  /**
   * Port of test_imp_nested from test_pregel_async_graph_structure.py
   */
  it("should handle nested imperative tasks", async () => {
    // Create a simple graph that adds "a" to each string in a list
    const StringsAnnotation = Annotation.Root({
      items: Annotation<string[]>({
        default: () => [],
        reducer: (_, b) => b,
      }),
    });

    const mynode = async (state: {
      items: string[];
    }): Promise<{ items: string[] }> => {
      return { items: state.items.map((it) => `${it}a`) };
    };

    const builder = new StateGraph({ stateSchema: StringsAnnotation })
      .addNode("mynode", mynode)
      .addEdge(START, "mynode");

    const addA = builder.compile();

    // Create tasks similar to the Python version
    const submapper = task("submapper", (input: number): string => {
      return String(input);
    });

    const mapper = task("mapper", async (input: number): Promise<string> => {
      // Simulate delay with setTimeout
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.max(input / 100, 1));
      });
      const result = await submapper(input);
      return result.repeat(2);
    });

    // Create a graph using entrypoint that combines these tasks
    const graph = entrypoint(
      { name: "graph", checkpointer: new MemorySaver() },
      async (input: number[]): Promise<string[]> => {
        // Map the input values in parallel using the mapper task
        const promises = input.map((i) => mapper(i));
        const mapped = await Promise.all(promises);

        // Use interrupt function to ask a question
        const answer = interrupt("question");

        // Append the answer to each mapped result
        const final = mapped.map((m: string) => `${m}${answer}`);

        // Use the addA graph to process the final list
        const result = await addA.invoke({ items: final });
        // Extract the items array from the result to match the Python behavior
        return result.items;
      }
    );

    // Create a thread for testing
    const thread1 = { configurable: { thread_id: "1" } };

    // Gather the streaming results from the graph
    const results = await gatherIterator(await graph.stream([0, 1], thread1));

    // Validate the streaming outputs (match Python's assertion exactly)
    expect(results).toEqual([
      { submapper: "0" },
      { mapper: "00" },
      { submapper: "1" },
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

    // Resume the graph with an answer
    const finalResult = await graph.invoke(
      new Command({ resume: "answer" }),
      thread1
    );

    // Verify the final result contains the expected values
    expect(finalResult).toEqual(["00answera", "11answera"]);
  });

  /**
   * Port of test_imp_sync_from_async from test_pregel_async_graph_structure.py
   */
  it("should handle synchronous tasks from async entrypoint", async () => {
    // Define synchronous task functions
    const foo = task(
      "foo",
      (state: Record<string, string>): Record<string, string> => {
        return { a: `${state.a}foo`, b: "bar" };
      }
    );

    const bar = task(
      "bar",
      (a: string, b: string, c?: string): Record<string, string> => {
        return { a: `${a}${b}`, c: `${c || ""}bark` };
      }
    );

    const baz = task(
      "baz",
      (state: Record<string, string>): Record<string, string> => {
        return { a: `${state.a}baz`, c: "something else" };
      }
    );

    // Create a graph using entrypoint that combines these tasks
    const graph = entrypoint(
      { name: "graph", checkpointer: new MemorySaver() },
      async (
        state: Record<string, string>
      ): Promise<Record<string, string>> => {
        const fooResult = await foo(state);
        const barResult = await bar(fooResult.a, fooResult.b);
        const bazResult = await baz(barResult);
        return bazResult;
      }
    );

    const config = { configurable: { thread_id: "1" } };

    // Gather the streaming results from the graph
    const results = await gatherIterator(
      await graph.stream({ a: "0" }, config)
    );

    // Validate the streaming outputs (match Python's assertion)
    expect(results).toEqual([
      { foo: { a: "0foo", b: "bar" } },
      { bar: { a: "0foobar", c: "bark" } },
      { baz: { a: "0foobarbaz", c: "something else" } },
      { graph: { a: "0foobarbaz", c: "something else" } },
    ]);
  });

  /**
   * Port of test_imp_stream_order from test_pregel_async_graph_structure.py
   */
  it("should handle imperative task streaming order", async () => {
    // Define task functions similar to the Python version
    const foo = task(
      "foo",
      async (
        state: Record<string, string>
      ): Promise<Record<string, string>> => {
        return { a: `${state.a}foo`, b: "bar" };
      }
    );

    const bar = task(
      "bar",
      async (
        a: string,
        b: string,
        c?: string
      ): Promise<Record<string, string>> => {
        return { a: `${a}${b}`, c: `${c || ""}bark` };
      }
    );

    const baz = task(
      "baz",
      async (
        state: Record<string, string>
      ): Promise<Record<string, string>> => {
        return { a: `${state.a}baz`, c: "something else" };
      }
    );

    // Create a graph using entrypoint that combines these tasks
    const graph = entrypoint(
      { name: "graph", checkpointer: new MemorySaver() },
      async (
        state: Record<string, string>
      ): Promise<Record<string, string>> => {
        const fooRes = await foo(state);
        const barRes = await bar(fooRes.a, fooRes.b);
        const bazRes = await baz(barRes);
        return bazRes;
      }
    );

    const thread1 = { configurable: { thread_id: "1" } };

    // Gather the streaming results from the graph
    const results = await gatherIterator(
      await graph.stream({ a: "0" }, thread1)
    );

    // Validate the streaming outputs (match Python's assertion exactly)
    expect(results).toEqual([
      { foo: { a: "0foo", b: "bar" } },
      { bar: { a: "0foobar", c: "bark" } },
      { baz: { a: "0foobarbaz", c: "something else" } },
      { graph: { a: "0foobarbaz", c: "something else" } },
    ]);
  });

  /**
   * Port of test_send_dedupe_on_resume from test_pregel_async_graph_structure.py
   */
  it("should deduplicate sends on resume", async () => {
    // Set up state annotation using operator.add (which concatenates in JS)
    const StateAnnotation = Annotation.Root({
      value: Annotation<string[]>({
        reducer: (a, b) => a.concat(b),
        default: () => [],
      }),
    });

    // First, create the InterruptOnce class that will interrupt on first tick
    class InterruptOnce {
      ticks = 0;

      constructor() {
        // No initialization needed
      }

      async call(
        state: typeof StateAnnotation.State
      ): Promise<{ value: string[] }> {
        this.ticks += 1;
        if (this.ticks === 1) {
          throw new Error("Bahh");
        }
        return { value: [`flaky|${state}`] };
      }
    }

    // Create a Node class that tracks its calls
    class Node {
      name: string;

      ticks = 0;

      constructor(name: string) {
        this.name = name;
      }

      async call(
        state: typeof StateAnnotation.State | Command
      ): Promise<{ value: string[] } | Command> {
        this.ticks += 1;

        // Handle different types of state
        const update =
          typeof state === "object" &&
          "value" in state &&
          Array.isArray(state.value)
            ? [this.name]
            : [
                `${this.name}|${
                  isCommand(state)
                    ? JSON.stringify(state.toJSON())
                    : String(state)
                }`,
              ];

        // If state is a Command, preserve its goto property
        if (isCommand(state)) {
          return new Command({
            goto: state.goto,
            update: { value: update },
          });
        } else {
          return { value: update };
        }
      }
    }

    // Create the routing functions
    const sendForFun = () => {
      return [
        new Send("2", new Command({ goto: new Send("2", 3) })),
        new Send("2", new Command({ goto: new Send("flaky", 4) })),
        "3.1",
      ];
    };

    const routeToThree = (): "3" => {
      return "3";
    };

    // Create node instances
    const node1 = new Node("1");
    const node2 = new Node("2");
    const node3 = new Node("3");
    const node31 = new Node("3.1");
    const flakyNode = new InterruptOnce();

    // Create the graph builder
    const builder = new StateGraph({ stateSchema: StateAnnotation })
      .addNode("1", (state) => node1.call(state))
      .addNode("2", (state) => node2.call(state))
      .addNode("3", (state) => node3.call(state))
      .addNode("3.1", (state) => node31.call(state))
      .addNode("flaky", (state) => flakyNode.call(state))
      .addEdge(START, "1")
      .addConditionalEdges("1", sendForFun)
      .addConditionalEdges("2", routeToThree);

    // Use memory saver for checkpointing
    const checkpointer = new MemorySaver();
    const graph = builder.compile({ checkpointer });

    const thread1 = { configurable: { thread_id: "1" } };

    // Initial invocation will fail at the "flaky" node
    try {
      await graph.invoke({ value: ["0"] }, thread1);
    } catch (error) {
      // Expected to fail
    }

    expect(node2.ticks).toBe(3);
    expect(flakyNode.ticks).toBe(1);

    // Resume execution
    const result = await graph.invoke(null, thread1);

    // Verify the final state
    expect(result.value).toEqual([
      "0",
      "1",
      "3.1",
      '2|{"goto":[{"node":"2","args":3}]}',
      '2|{"goto":[{"node":"flaky","args":4}]}',
      "3",
      "2|3",
      "flaky|4",
      "3",
    ]);

    // Node "2" doesn't get called again, as we recover writes saved before
    expect(node2.ticks).toBe(3);

    // Node "flaky" gets called again after the interrupt
    expect(flakyNode.ticks).toBe(2);

    // Check history
    const history = await gatherIterator(await graph.getStateHistory(thread1));
    // console.log(JSON.stringify(history, null, 2));

    // TODO: check full history structure against the python version
    // Verify history snapshots are in correct order and contain expected data
    // expect(history.length).toBe(5); // Should have all snapshots

    // Check the final state in history
    expect(history[0].values.value).toEqual([
      "0",
      "1",
      "3.1",
      '2|{"goto":[{"node":"2","args":3}]}',
      '2|{"goto":[{"node":"flaky","args":4}]}',
      "3",
      "2|3",
      "flaky|4",
      "3",
    ]);
  });
});
