import { describe, it, expect, jest } from "@jest/globals";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { RunnablePassthrough } from "@langchain/core/runnables";
import { StateGraph } from "../../graph/state.js";
import { Annotation } from "../../web.js";
import {
  Send,
  Command,
  isCommand,
  INTERRUPT,
  START,
  END,
} from "../../constants.js";
import { task, entrypoint } from "../../func/index.js";
import { interrupt } from "../../interrupt.js";
import { gatherIterator } from "../../utils.js";
import { FakeTracer } from "../utils.js";
import { initializeAsyncLocalStorageSingleton } from "../../setup/async_local_storage.js";
import { Pregel, Channel } from "../../pregel/index.js";
import { Topic } from "../../channels/topic.js";
import { LastValue } from "../../channels/last_value.js";

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
    const builder = new StateGraph(StateAnnotation)
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
    const builder = new StateGraph(StateAnnotation)
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
    const builder = new StateGraph(StateAnnotation)
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

    const builder = new StateGraph(StringsAnnotation)
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
    const builder = new StateGraph(StateAnnotation)
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

  /**
   * Port of test_invoke_two_processes_two_in_join_two_out from test_pregel_async_graph_structure.py
   */
  it("should process two inputs joined into one topic and produce two outputs", async () => {
    const addOne = jest.fn((x: number): number => x + 1);
    const add10Each = jest.fn((x: number[]): number[] =>
      x.map((y) => y + 10).sort()
    );

    const one = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(Channel.writeTo(["inbox"]));

    const chainThree = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(Channel.writeTo(["inbox"]));

    const chainFour = Channel.subscribeTo("inbox")
      .pipe(add10Each)
      .pipe(Channel.writeTo(["output"]));

    const app = new Pregel({
      nodes: {
        one,
        chainThree,
        chainFour,
      },
      channels: {
        inbox: new Topic<number>(),
        output: new LastValue<number>(),
        input: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: "output",
    });

    // Invoke app and check results
    // We get a single array result as chain_four waits for all publishers to finish
    // before operating on all elements published to topic_two as an array
    for (let i = 0; i < 100; i += 1) {
      expect(await app.invoke(2)).toEqual([13, 13]);
    }

    // Use Promise.all to simulate concurrent execution
    const results = await Promise.all(
      Array(100)
        .fill(null)
        .map(async () => app.invoke(2))
    );

    results.forEach((result) => {
      expect(result).toEqual([13, 13]);
    });
  });

  /**
   * Port of test_invoke_join_then_call_other_pregel from test_pregel_async_graph_structure.py
   */
  it("should invoke join then call other app", async () => {
    const addOne = jest.fn((x: number): number => x + 1);
    const add10Each = jest.fn((x: number[]): number[] => x.map((y) => y + 10));

    const innerApp = new Pregel({
      nodes: {
        one: Channel.subscribeTo("input")
          .pipe(addOne)
          .pipe(Channel.writeTo(["output"])),
      },
      channels: {
        output: new LastValue<number>(),
        input: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: "output",
    });

    const one = Channel.subscribeTo("input")
      .pipe(add10Each)
      .pipe(Channel.writeTo(["inbox_one"]).map());

    const two = Channel.subscribeTo("inbox_one")
      .pipe(() => innerApp.map())
      .pipe((x: number[]) => x.sort())
      .pipe(Channel.writeTo(["outbox_one"]));

    const chainThree = Channel.subscribeTo("outbox_one")
      .pipe((x: number[]) => x.reduce((a, b) => a + b, 0))
      .pipe(Channel.writeTo(["output"]));

    const app = new Pregel({
      nodes: {
        one,
        two,
        chain_three: chainThree,
      },
      channels: {
        inbox_one: new Topic<number>(),
        outbox_one: new Topic<number>(),
        output: new LastValue<number>(),
        input: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: "output",
    });

    // Run the test 10 times sequentially
    for (let i = 0; i < 10; i += 1) {
      expect(await app.invoke([2, 3])).toEqual(27);
    }

    // Run the test 10 times in parallel
    const results = await Promise.all(
      Array(10)
        .fill(null)
        .map(() => app.invoke([2, 3]))
    );
    expect(results).toEqual(Array(10).fill(27));
  });

  /**
   * Port of test_invoke_two_processes_one_in_two_out from test_pregel_async_graph_structure.py
   */
  it("should handle two processes with one input and two outputs", async () => {
    const addOne = jest.fn((x: number) => x + 1);

    const one = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(
        Channel.writeTo([], {
          output: new RunnablePassthrough(),
          between: new RunnablePassthrough(),
        })
      );

    const two = Channel.subscribeTo("between")
      .pipe(addOne)
      .pipe(Channel.writeTo(["output"]));

    const app = new Pregel({
      nodes: { one, two },
      channels: {
        input: new LastValue<number>(),
        output: new LastValue<number>(),
        between: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: "output",
      streamChannels: ["output", "between"],
    });

    const results = await app.stream(2);
    const streamResults = await gatherIterator(results);

    expect(streamResults).toEqual([
      { between: 3, output: 3 },
      { between: 3, output: 4 },
    ]);
  });

  /**
   * Port of test_invoke_two_processes_no_out from test_pregel_async_graph_structure.py
   */
  it("should finish executing without output", async () => {
    const addOne = jest.fn((x: number): number => x + 1);
    const one = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(Channel.writeTo(["between"]));
    const two = Channel.subscribeTo("between").pipe(addOne);

    const app = new Pregel({
      nodes: { one, two },
      channels: {
        input: new LastValue<number>(),
        between: new LastValue<number>(),
        output: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: "output",
    });

    // It finishes executing (once no more messages being published)
    // but returns nothing, as nothing was published to OUT topic
    expect(await app.invoke(2)).toBeUndefined();
  });

  /**
   * Port of test_max_concurrency from test_pregel_async_graph_structure.py
   */
  it("should handle maximum concurrency limits", async () => {
    // Define the StateAnnotation for accumulating lists
    const StateAnnotation = Annotation.Root({
      items: Annotation<unknown[]>({
        reducer: (a, b) => a.concat(b),
        default: () => [],
      }),
    });

    // Node class to track concurrent executions
    class Node {
      name: string;

      currently = 0;

      maxCurrently = 0;

      constructor(name: string) {
        this.name = name;
      }

      async call(state: unknown): Promise<{ items: unknown[] }> {
        this.currently += 1;
        if (this.currently > this.maxCurrently) {
          this.maxCurrently = this.currently;
        }
        // Use a small delay to simulate async work
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1);
        });
        this.currently -= 1;
        return { items: [state] };
      }
    }

    // Define simple node functions
    const one = (): { items: unknown[] } => {
      return { items: ["1"] };
    };

    const three = (): { items: unknown[] } => {
      return { items: ["3"] };
    };

    // Create a function that sends to many nodes
    const sendToMany = (): Send[] => {
      return Array.from({ length: 100 }, (_, idx) => new Send("2", idx));
    };

    const routeToThree = (): "3" => {
      return "3";
    };

    // Create node instance that will track concurrent executions
    const node2 = new Node("2");

    // Create the graph
    const builder = new StateGraph(StateAnnotation)
      .addNode("1", one)
      .addNode("2", (state) => node2.call(state))
      .addNode("3", three)
      .addEdge(START, "1")
      .addConditionalEdges("1", sendToMany)
      .addConditionalEdges("2", routeToThree);

    const graph = builder.compile();

    // Test without concurrency limits
    const result1 = await graph.invoke({ items: ["0"] });

    // Create expected result with all numbers from 0-99
    const expectedNumbers = Array.from({ length: 100 }, (_, i) => i);

    // Check the result includes the expected values
    expect(result1.items).toEqual(["0", "1", ...expectedNumbers, "3"]);
    expect(node2.maxCurrently).toBe(100);
    expect(node2.currently).toBe(0);

    // Reset for next test
    node2.maxCurrently = 0;

    // Test with concurrency limit of 10
    const result2 = await graph.invoke(
      { items: ["0"] },
      { maxConcurrency: 10 }
    );

    // Check the result includes the expected values
    expect(result2.items).toEqual(["0", "1", ...expectedNumbers, "3"]);
    expect(node2.maxCurrently).toBe(10);
    expect(node2.currently).toBe(0);

    // Test with checkpointer and interrupts
    const checkpointer = new MemorySaver();
    const graphWithInterrupt = builder.compile({
      checkpointer,
      interruptBefore: ["2"],
    });

    const thread1 = {
      maxConcurrency: 10,
      configurable: { thread_id: "1" },
    };

    // First invocation should stop at the interrupt
    const result3 = await graphWithInterrupt.invoke({ items: ["0"] }, thread1);
    expect(result3.items).toEqual(["0", "1"]);

    // Second invocation should complete the execution
    const result4 = await graphWithInterrupt.invoke(null, thread1);
    expect(result4.items).toEqual(["0", "1", ...expectedNumbers, "3"]);
  });

  /**
   * Port of test_max_concurrency_control from test_pregel_async_graph_structure.py
   */
  it("should handle maximum concurrency limits with commands", async () => {
    // Define the StateAnnotation for accumulating lists
    const StateAnnotation = Annotation.Root({
      items: Annotation<unknown[]>({
        reducer: (a, b) => a.concat(b),
        default: () => [],
      }),
    });

    // Node functions that use Command objects for control flow
    const node1 = (): Command => {
      // Send numbers 0-99 to node2
      const sends = Array.from({ length: 100 }, (_, idx) => new Send("2", idx));
      return new Command({
        update: { items: ["1"] },
        goto: sends,
      });
    };

    // Keep track of concurrent executions of node2
    let node2Currently = 0;
    let node2MaxCurrently = 0;

    const node2 = (state: unknown): Promise<Command> => {
      return new Promise((resolve) => {
        // Track concurrent executions
        node2Currently += 1;
        if (node2Currently > node2MaxCurrently) {
          node2MaxCurrently = node2Currently;
        }

        // Simulate async work
        setTimeout(() => {
          node2Currently -= 1;
          resolve(
            new Command({
              update: { items: [state] },
              goto: "3",
            })
          );
        }, 1);
      });
    };

    const node3 = (): { items: string[] } => {
      return { items: ["3"] };
    };

    // Create the graph
    const builder = new StateGraph(StateAnnotation)
      .addNode("1", node1, { ends: ["2"] })
      .addNode("2", node2, { ends: ["3"] })
      .addNode("3", node3)
      .addEdge(START, "1");

    const graph = builder.compile();

    // Test without concurrency limits
    const result1 = await graph.invoke({ items: ["0"] });

    // Create expected result with all numbers from 0-99
    const expectedNumbers = Array.from({ length: 100 }, (_, i) => i);

    // Check the result includes the expected values
    expect(result1.items).toEqual(["0", "1", ...expectedNumbers, "3"]);
    expect(node2MaxCurrently).toBe(100);
    expect(node2Currently).toBe(0);

    // Reset for next test
    node2MaxCurrently = 0;

    // Test with concurrency limit of 10
    const result2 = await graph.invoke(
      { items: ["0"] },
      { maxConcurrency: 10 }
    );

    // Check the result includes the expected values
    expect(result2.items).toEqual(["0", "1", ...expectedNumbers, "3"]);
    expect(node2MaxCurrently).toBe(10);
    expect(node2Currently).toBe(0);

    // Test with checkpointer and interrupts
    const checkpointer = new MemorySaver();
    const graphWithInterrupt = builder.compile({
      checkpointer,
      interruptBefore: ["2"],
    });

    const thread1 = {
      maxConcurrency: 10,
      configurable: { thread_id: "1" },
    };

    // First invocation should stop at the interrupt
    const result3 = await graphWithInterrupt.invoke({ items: ["0"] }, thread1);
    expect(result3.items).toEqual(["0", "1"]);

    // Second invocation should complete the execution
    const result4 = await graphWithInterrupt.invoke(null, thread1);
    expect(result4.items).toEqual(["0", "1", ...expectedNumbers, "3"]);
  });

  /**
   * Port of test_conditional_entrypoint_graph from test_pregel_async_graph_structure.py
   */
  it("should handle conditional entrypoint graphs", async () => {
    const StateAnnotation = Annotation.Root({
      value: Annotation<string>({
        default: () => "",
        reducer: (_, b) => b,
      }),
    });

    // Define simple node functions that process strings
    const left = async (data: typeof StateAnnotation.State) => {
      return { value: `${data.value}->left` };
    };

    const right = async (data: typeof StateAnnotation.State) => {
      return { value: `${data.value}->right` };
    };

    // Function to decide which path to take
    const shouldStart = (data: typeof StateAnnotation.State) => {
      // Logic to decide where to start
      if (data.value.length > 10) {
        return "go-right";
      } else {
        return "go-left";
      }
    };

    // Define a new graph
    const workflow = new StateGraph(StateAnnotation)
      .addNode("left", left)
      .addNode("right", right)

      // In JS we use addConditionalEdges instead of setConditionalEntryPoint
      .addConditionalEdges(START, shouldStart, {
        "go-left": "left",
        "go-right": "right",
      })

      // Add remaining edges
      .addConditionalEdges("left", () => END)
      .addEdge("right", END);

    const app = workflow.compile();

    // Test invoke
    const result = await app.invoke({ value: "what is weather in sf" });
    expect(result.value).toBe("what is weather in sf->right");

    // Test stream
    const streamResults = await gatherIterator(
      await app.stream({ value: "what is weather in sf" })
    );
    expect(streamResults).toEqual([
      { right: { value: "what is weather in sf->right" } },
    ]);
  });

  /**
   * Port of test_conditional_entrypoint_graph_state from test_pregel_async_graph_structure.py
   */
  it("should handle conditional entrypoint graphs with state", async () => {
    // Define the state annotation
    const StateAnnotation = Annotation.Root({
      input: Annotation<string>({
        default: () => "",
        reducer: (_, b) => b,
      }),
      output: Annotation<string>({
        default: () => "",
        reducer: (_, b) => b,
      }),
      steps: Annotation<string[]>({
        default: () => [],
        reducer: (a, b) => a.concat(b),
      }),
    });

    // Define node functions that work with state
    const left = async (
      state: typeof StateAnnotation.State
    ): Promise<typeof StateAnnotation.Update> => {
      return { output: `${state.input}->left` };
    };

    const right = async (
      state: typeof StateAnnotation.State
    ): Promise<typeof StateAnnotation.Update> => {
      return { output: `${state.input}->right` };
    };

    // Function to decide which path to take
    const shouldStart = (
      state: typeof StateAnnotation.State
    ): "go-left" | "go-right" => {
      // Verify steps is an empty array as expected
      expect(state.steps).toEqual([]);

      // Logic to decide where to start
      if (state.input.length > 10) {
        return "go-right";
      } else {
        return "go-left";
      }
    };

    // Define a new graph with state
    const workflow = new StateGraph(StateAnnotation)
      .addNode("left", left)
      .addNode("right", right);

    // In JS we use addConditionalEdges instead of setConditionalEntryPoint
    workflow
      .addConditionalEdges(START, shouldStart, {
        "go-left": "left",
        "go-right": "right",
      })

      // Add remaining edges
      .addConditionalEdges("left", () => END)
      .addEdge("right", END);

    const app = workflow.compile();

    // Test invoke
    const result = await app.invoke({
      input: "what is weather in sf",
      output: "",
      steps: [],
    });

    expect(result).toEqual({
      input: "what is weather in sf",
      output: "what is weather in sf->right",
      steps: [],
    });

    // Test stream
    const streamResults = await gatherIterator(
      await app.stream({
        input: "what is weather in sf",
        output: "",
        steps: [],
      })
    );

    expect(streamResults).toEqual([
      { right: { output: "what is weather in sf->right" } },
    ]);
  });
});
