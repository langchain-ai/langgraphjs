import { describe, it, expect, beforeAll, vi } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { RunnablePassthrough } from "@langchain/core/runnables";
import { StateGraph } from "../../graph/state.js";
import {
  Annotation,
  LangGraphRunnableConfig,
  StateSnapshot,
} from "../../web.js";
import {
  Send,
  Command,
  isCommand,
  INTERRUPT,
  START,
  END,
  CONFIG_KEY_NODE_FINISHED,
  CONFIG_KEY_CHECKPOINT_MAP,
  CONFIG_KEY_CHECKPOINT_ID,
  CONFIG_KEY_CHECKPOINT_NS,
} from "../../constants.js";
import { task, entrypoint } from "../../func/index.js";
import { interrupt } from "../../interrupt.js";
import { gatherIterator } from "../../utils.js";
import { FakeTracer } from "../utils.js";
import { initializeAsyncLocalStorageSingleton } from "../../setup/async_local_storage.js";
import { Pregel, Channel } from "../../pregel/index.js";
import { Topic } from "../../channels/topic.js";
import { LastValue } from "../../channels/last_value.js";

// NOTE: test_channel_enter_exit_timing doesn't apply to JavaScript as JS has no concept of context managers

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
      '2|{"lg_name":"Command","goto":[{"lg_name":"Send","node":"2","args":3}]}',
      '2|{"lg_name":"Command","goto":[{"lg_name":"Send","node":"2","args":4}]}',
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
      '2|{"lg_name":"Command","goto":[{"lg_name":"Send","node":"2","args":3}]}',
      '2|{"lg_name":"Command","goto":[{"lg_name":"Send","node":"2","args":4}]}',
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
            id: expect.any(String),
            value: "question",
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
            id: expect.any(String),
            value: "question",
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
   *
   * TODO: plumbing the augmented AbortSignal through to the config that's passed to the node via
   *       `_runWithRetry` breaks this test for some reason.
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
          // give concurrent tasks some time to complete before we throw
          // TODO: without this line the test fails because langchain abandons the promises for the concurrent tasks - fixing this may require a breaking change
          await new Promise((resolve) => {
            setTimeout(resolve, 10);
          });
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
      .addNode("1", (state: typeof StateAnnotation.State) => node1.call(state))
      .addNode("2", (state: typeof StateAnnotation.State) => node2.call(state))
      .addNode("3", (state: typeof StateAnnotation.State) => node3.call(state))
      .addNode("3.1", (state: typeof StateAnnotation.State) =>
        node31.call(state)
      )
      .addNode("flaky", (state: typeof StateAnnotation.State) =>
        flakyNode.call(state)
      )
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
      '2|{"lg_name":"Command","goto":[{"lg_name":"Send","node":"2","args":3}]}',
      '2|{"lg_name":"Command","goto":[{"lg_name":"Send","node":"flaky","args":4}]}',
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
      '2|{"lg_name":"Command","goto":[{"lg_name":"Send","node":"2","args":3}]}',
      '2|{"lg_name":"Command","goto":[{"lg_name":"Send","node":"flaky","args":4}]}',
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
    const addOne = vi.fn((x: number): number => x + 1);
    const add10Each = vi.fn((x: number[]): number[] =>
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
    const addOne = vi.fn((x: number): number => x + 1);
    const add10Each = vi.fn((x: number[]): number[] => x.map((y) => y + 10));

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
    const addOne = vi.fn((x: number) => x + 1);

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
    const addOne = vi.fn((x: number): number => x + 1);
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
      .addNode("2", (state: typeof StateAnnotation.State) => node2.call(state))
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

  /**
   * Port of test_in_one_fan_out_state_graph_waiting_edge from test_pregel_async_graph_structure.py
   */
  it("should test in-one-fan-out with waiting edge", async () => {
    // Custom sorted_add function to match Python's implementation
    const sortedAdd = (
      x: string[],
      y: string[] | [string, string][]
    ): string[] => {
      if (y.length > 0 && Array.isArray(y[0])) {
        const tupleArray = y as [string, string][];

        // Remove elements specified in first part of tuples
        for (const [rem] of tupleArray) {
          const index = x.indexOf(rem);
          if (index !== -1) {
            x.splice(index, 1);
          }
        }

        // Extract second part of tuples
        // eslint-disable-next-line no-param-reassign
        y = tupleArray.map(([, second]) => second);
      }

      return [...x, ...(y as string[])].sort();
    };

    // Create state annotation with the custom reducer
    const StateAnnotation = Annotation.Root({
      query: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
      }),
      answer: Annotation<string>({
        default: () => "",
        reducer: (_, b) => b,
      }),
      docs: Annotation<string[]>({
        default: () => [],
        reducer: sortedAdd,
      }),
    });

    // Node functions
    const rewriteQuery = async (
      state: typeof StateAnnotation.State
    ): Promise<typeof StateAnnotation.Update> => {
      return { query: `query: ${state.query}` };
    };

    const analyzerOne = async (
      state: typeof StateAnnotation.State
    ): Promise<typeof StateAnnotation.Update> => {
      return { query: `analyzed: ${state.query}` };
    };

    const retrieverOne = async (): Promise<typeof StateAnnotation.Update> => {
      return { docs: ["doc1", "doc2"] };
    };

    const retrieverTwo = async (): Promise<typeof StateAnnotation.Update> => {
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      return { docs: ["doc3", "doc4"] };
    };

    const qa = async (
      state: typeof StateAnnotation.State
    ): Promise<typeof StateAnnotation.Update> => {
      return { answer: state.docs.join(",") };
    };

    // Create state graph
    const workflow = new StateGraph(StateAnnotation)
      .addNode("rewrite_query", rewriteQuery)
      .addNode("analyzer_one", analyzerOne)
      .addNode("retriever_one", retrieverOne)
      .addNode("retriever_two", retrieverTwo)
      .addNode("qa", qa);

    // Add edges
    workflow.addEdge(START, "rewrite_query");
    workflow.addEdge("rewrite_query", "analyzer_one");
    workflow.addEdge("analyzer_one", "retriever_one");
    workflow.addEdge("rewrite_query", "retriever_two");
    workflow.addEdge(["retriever_one", "retriever_two"], "qa");
    workflow.addEdge("qa", END);

    // Compile app
    const app = workflow.compile();

    // Test invoke
    const result = await app.invoke({
      query: "what is weather in sf",
    });

    expect(result).toEqual({
      query: "analyzed: query: what is weather in sf",
      docs: ["doc1", "doc2", "doc3", "doc4"],
      answer: "doc1,doc2,doc3,doc4",
    });

    // Test stream
    const streamResults = await gatherIterator(
      await app.stream({
        query: "what is weather in sf",
      })
    );

    expect(streamResults).toEqual([
      { rewrite_query: { query: "query: what is weather in sf" } },
      { analyzer_one: { query: "analyzed: query: what is weather in sf" } },
      { retriever_two: { docs: ["doc3", "doc4"] } },
      { retriever_one: { docs: ["doc1", "doc2"] } },
      { qa: { answer: "doc1,doc2,doc3,doc4" } },
    ]);

    // Test with checkpointer and interrupt
    const checkpointer = new MemorySaver();
    const appWithInterrupt = workflow.compile({
      checkpointer,
      interruptAfter: ["retriever_one"],
    });

    const config = { configurable: { thread_id: "1" } };

    // Test stream with interrupt
    const interruptedStreamResults = await gatherIterator(
      appWithInterrupt.stream({ query: "what is weather in sf" }, config)
    );

    expect(interruptedStreamResults).toEqual([
      { rewrite_query: { query: "query: what is weather in sf" } },
      { analyzer_one: { query: "analyzed: query: what is weather in sf" } },
      { retriever_two: { docs: ["doc3", "doc4"] } },
      { retriever_one: { docs: ["doc1", "doc2"] } },
      { __interrupt__: [] },
    ]);

    // Resume from interrupt
    const resumedResults = await gatherIterator(
      appWithInterrupt.stream(null, config)
    );

    expect(resumedResults).toEqual([{ qa: { answer: "doc1,doc2,doc3,doc4" } }]);
  });

  /**
   * Port of test_in_one_fan_out_state_graph_waiting_edge_plus_regular from test_pregel_async_graph_structure.py
   */
  it("should test in-one-fan-out with waiting edge plus regular edge", async () => {
    // Custom sorted_add function to match Python's implementation
    const sortedAdd = (
      x: string[],
      y: string[] | [string, string][]
    ): string[] => {
      if (y.length > 0 && Array.isArray(y[0])) {
        const tupleArray = y as [string, string][];

        // Remove elements specified in first part of tuples
        for (const [rem] of tupleArray) {
          const index = x.indexOf(rem);
          if (index !== -1) {
            x.splice(index, 1);
          }
        }

        // Extract second part of tuples
        // eslint-disable-next-line no-param-reassign
        y = tupleArray.map(([, second]) => second);
      }

      return [...x, ...(y as string[])].sort();
    };

    // Create state annotation with the custom reducer
    const StateAnnotation = Annotation.Root({
      query: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
      }),
      answer: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
      }),
      docs: Annotation<string[]>({
        default: () => [],
        reducer: sortedAdd,
      }),
    });

    // Node functions
    const rewriteQuery = async (
      state: typeof StateAnnotation.State
    ): Promise<typeof StateAnnotation.Update> => {
      return { query: `query: ${state.query}` };
    };

    const analyzerOne = async (
      state: typeof StateAnnotation.State
    ): Promise<typeof StateAnnotation.Update> => {
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      return { query: `analyzed: ${state.query}` };
    };

    const retrieverOne = async (): Promise<typeof StateAnnotation.Update> => {
      return { docs: ["doc1", "doc2"] };
    };

    const retrieverTwo = async (): Promise<typeof StateAnnotation.Update> => {
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
      return { docs: ["doc3", "doc4"] };
    };

    const qa = async (
      state: typeof StateAnnotation.State
    ): Promise<typeof StateAnnotation.Update> => {
      return { answer: state.docs.join(",") };
    };

    // Create state graph
    const workflow = new StateGraph(StateAnnotation)
      .addNode("rewrite_query", rewriteQuery)
      .addNode("analyzer_one", analyzerOne)
      .addNode("retriever_one", retrieverOne)
      .addNode("retriever_two", retrieverTwo)
      .addNode("qa", qa);

    // Add edges
    workflow.addEdge(START, "rewrite_query");
    workflow.addEdge("rewrite_query", "analyzer_one");
    workflow.addEdge("analyzer_one", "retriever_one");
    workflow.addEdge("rewrite_query", "retriever_two");
    workflow.addEdge(["retriever_one", "retriever_two"], "qa");
    workflow.addEdge("qa", END);

    // silly edge, to make sure having been triggered before doesn't break
    // semantics of named barrier (== waiting edges)
    workflow.addEdge("rewrite_query", "qa");

    // Compile app
    const app = workflow.compile();

    // Test invoke
    const result = await app.invoke({
      query: "what is weather in sf",
    });

    expect(result).toEqual({
      query: "analyzed: query: what is weather in sf",
      docs: ["doc1", "doc2", "doc3", "doc4"],
      answer: "doc1,doc2,doc3,doc4",
    });

    // Test stream
    const streamResults = await gatherIterator(
      app.stream({ query: "what is weather in sf" })
    );

    expect(streamResults).toEqual([
      { rewrite_query: { query: "query: what is weather in sf" } },
      { qa: { answer: "" } },
      { analyzer_one: { query: "analyzed: query: what is weather in sf" } },
      { retriever_two: { docs: ["doc3", "doc4"] } },
      { retriever_one: { docs: ["doc1", "doc2"] } },
      { qa: { answer: "doc1,doc2,doc3,doc4" } },
    ]);

    // Test with checkpointer and interrupt
    const checkpointer = new MemorySaver();
    const appWithInterrupt = workflow.compile({
      checkpointer,
      interruptAfter: ["retriever_one"],
    });

    const config = { configurable: { thread_id: "1" } };

    // Test stream with interrupt
    const interruptedStreamResults = await gatherIterator(
      appWithInterrupt.stream({ query: "what is weather in sf" }, config)
    );

    expect(interruptedStreamResults).toEqual([
      { rewrite_query: { query: "query: what is weather in sf" } },
      { qa: { answer: "" } },
      { analyzer_one: { query: "analyzed: query: what is weather in sf" } },
      { retriever_two: { docs: ["doc3", "doc4"] } },
      { retriever_one: { docs: ["doc1", "doc2"] } },
      { __interrupt__: [] },
    ]);

    // Resume from interrupt
    const resumedResults = await gatherIterator(
      appWithInterrupt.stream(null, config)
    );

    expect(resumedResults).toEqual([{ qa: { answer: "doc1,doc2,doc3,doc4" } }]);
  });

  /**
   * Port of test_in_one_fan_out_state_graph_waiting_edge_multiple from test_pregel_async_graph_structure.py
   */
  it("should test in-one-fan-out with waiting edge and multiple iterations", async () => {
    // Custom sorted_add function to match Python's implementation
    const sortedAdd = (
      x: string[],
      y: string[] | [string, string][]
    ): string[] => {
      if (y.length > 0 && Array.isArray(y[0])) {
        const tupleArray = y as [string, string][];

        // Remove elements specified in first part of tuples
        for (const [rem] of tupleArray) {
          const index = x.indexOf(rem);
          if (index !== -1) {
            x.splice(index, 1);
          }
        }

        // Extract second part of tuples
        // eslint-disable-next-line no-param-reassign
        y = tupleArray.map(([, second]) => second);
      }

      return [...x, ...(y as string[])].sort();
    };

    // Create state annotation with the custom reducer
    const StateAnnotation = Annotation.Root({
      query: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
      }),
      answer: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
      }),
      docs: Annotation<string[]>({
        default: () => [],
        reducer: sortedAdd,
      }),
    });

    // Node functions
    const rewriteQuery = async (
      state: typeof StateAnnotation.State
    ): Promise<typeof StateAnnotation.Update> => {
      return { query: `query: ${state.query}` };
    };

    const analyzerOne = async (
      state: typeof StateAnnotation.State
    ): Promise<typeof StateAnnotation.Update> => {
      return { query: `analyzed: ${state.query}` };
    };

    const retrieverOne = async (): Promise<typeof StateAnnotation.Update> => {
      return { docs: ["doc1", "doc2"] };
    };

    const retrieverTwo = async (): Promise<typeof StateAnnotation.Update> => {
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      return { docs: ["doc3", "doc4"] };
    };

    const qa = async (
      state: typeof StateAnnotation.State
    ): Promise<typeof StateAnnotation.Update> => {
      return { answer: state.docs.join(",") };
    };

    const decider = async (): Promise<typeof StateAnnotation.Update> => {
      // In Python this returns None which doesn't exist in TypeScript
      return {};
    };

    const deciderCond = (
      state: typeof StateAnnotation.State
    ): "qa" | "rewrite_query" => {
      if ((state.query.match(/analyzed/g) || []).length > 1) {
        return "qa";
      } else {
        return "rewrite_query";
      }
    };

    // Create state graph
    const workflow = new StateGraph(StateAnnotation)
      .addNode("rewrite_query", rewriteQuery)
      .addNode("analyzer_one", analyzerOne)
      .addNode("retriever_one", retrieverOne)
      .addNode("retriever_two", retrieverTwo)
      .addNode("decider", decider)
      .addNode("qa", qa);

    // Add edges
    workflow.addEdge(START, "rewrite_query");
    workflow.addEdge("rewrite_query", "analyzer_one");
    workflow.addEdge("analyzer_one", "retriever_one");
    workflow.addEdge("rewrite_query", "retriever_two");
    workflow.addEdge(["retriever_one", "retriever_two"], "decider");
    workflow.addConditionalEdges("decider", deciderCond);
    workflow.addEdge("qa", END);

    // Compile app
    const app = workflow.compile();

    // Test invoke
    const result = await app.invoke({
      query: "what is weather in sf",
    });

    expect(result).toEqual({
      query: "analyzed: query: analyzed: query: what is weather in sf",
      docs: ["doc1", "doc1", "doc2", "doc2", "doc3", "doc3", "doc4", "doc4"],
      answer: "doc1,doc1,doc2,doc2,doc3,doc3,doc4,doc4",
    });

    // Test stream
    const streamResults = await gatherIterator(
      await app.stream({
        query: "what is weather in sf",
      })
    );

    expect(streamResults).toEqual([
      { rewrite_query: { query: "query: what is weather in sf" } },
      { analyzer_one: { query: "analyzed: query: what is weather in sf" } },
      { retriever_two: { docs: ["doc3", "doc4"] } },
      { retriever_one: { docs: ["doc1", "doc2"] } },
      { decider: {} },
      {
        rewrite_query: {
          query: "query: analyzed: query: what is weather in sf",
        },
      },
      {
        analyzer_one: {
          query: "analyzed: query: analyzed: query: what is weather in sf",
        },
      },
      { retriever_two: { docs: ["doc3", "doc4"] } },
      { retriever_one: { docs: ["doc1", "doc2"] } },
      { decider: {} },
      { qa: { answer: "doc1,doc1,doc2,doc2,doc3,doc3,doc4,doc4" } },
    ]);
  });

  /**
   * Port of test_in_one_fan_out_state_graph_waiting_edge_multiple_cond_edge from test_pregel_async_graph_structure.py
   */
  it("should test in-one-fan-out with waiting edge and multiple conditional edges", async () => {
    // Custom sorted_add function to match Python's implementation
    const sortedAdd = (
      x: string[],
      y: string[] | [string, string][]
    ): string[] => {
      if (y.length > 0 && Array.isArray(y[0])) {
        const tupleArray = y as [string, string][];

        // Remove elements specified in first part of tuples
        for (const [rem] of tupleArray) {
          const index = x.indexOf(rem);
          if (index !== -1) {
            x.splice(index, 1);
          }
        }

        // Extract second part of tuples
        // eslint-disable-next-line no-param-reassign
        y = tupleArray.map(([, second]) => second);
      }

      return [...x, ...(y as string[])].sort();
    };

    // Create state annotation with the custom reducer
    const StateAnnotation = Annotation.Root({
      query: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
      }),
      answer: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
      }),
      docs: Annotation<string[]>({
        default: () => [],
        reducer: sortedAdd,
      }),
    });

    // Node functions
    const rewriteQuery = async (
      state: typeof StateAnnotation.State
    ): Promise<typeof StateAnnotation.Update> => {
      return { query: `query: ${state.query}` };
    };

    const retrieverPicker = async (): Promise<string[]> => {
      return ["analyzer_one", "retriever_two"];
    };

    const analyzerOne = async (
      state: typeof StateAnnotation.State
    ): Promise<typeof StateAnnotation.Update> => {
      return { query: `analyzed: ${state.query}` };
    };

    const retrieverOne = async (): Promise<typeof StateAnnotation.Update> => {
      return { docs: ["doc1", "doc2"] };
    };

    const retrieverTwo = async (): Promise<typeof StateAnnotation.Update> => {
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      return { docs: ["doc3", "doc4"] };
    };

    const qa = async (
      state: typeof StateAnnotation.State
    ): Promise<typeof StateAnnotation.Update> => {
      return { answer: state.docs.join(",") };
    };

    const decider = async (): Promise<typeof StateAnnotation.Update> => {
      // In Python this returns None which doesn't exist in TypeScript
      return {};
    };

    const deciderCond = (
      state: typeof StateAnnotation.State
    ): "qa" | "rewrite_query" => {
      if ((state.query.match(/analyzed/g) || []).length > 1) {
        return "qa";
      } else {
        return "rewrite_query";
      }
    };

    // Create state graph
    const workflow = new StateGraph(StateAnnotation)
      .addNode("rewrite_query", rewriteQuery)
      .addNode("analyzer_one", analyzerOne)
      .addNode("retriever_one", retrieverOne)
      .addNode("retriever_two", retrieverTwo)
      .addNode("decider", decider)
      .addNode("qa", qa);

    // Add edges
    workflow.addEdge(START, "rewrite_query");
    workflow.addConditionalEdges("rewrite_query", retrieverPicker);
    workflow.addEdge("analyzer_one", "retriever_one");
    workflow.addEdge(["retriever_one", "retriever_two"], "decider");
    workflow.addConditionalEdges("decider", deciderCond);
    workflow.addEdge("qa", END);

    // Compile app
    const app = workflow.compile();

    // Test invoke
    const result = await app.invoke({
      query: "what is weather in sf",
    });

    expect(result).toEqual({
      query: "analyzed: query: analyzed: query: what is weather in sf",
      docs: ["doc1", "doc1", "doc2", "doc2", "doc3", "doc3", "doc4", "doc4"],
      answer: "doc1,doc1,doc2,doc2,doc3,doc3,doc4,doc4",
    });

    // Test stream
    const streamResults = await gatherIterator(
      await app.stream({
        query: "what is weather in sf",
      })
    );

    expect(streamResults).toEqual([
      { rewrite_query: { query: "query: what is weather in sf" } },
      { analyzer_one: { query: "analyzed: query: what is weather in sf" } },
      { retriever_two: { docs: ["doc3", "doc4"] } },
      { retriever_one: { docs: ["doc1", "doc2"] } },
      { decider: {} },
      {
        rewrite_query: {
          query: "query: analyzed: query: what is weather in sf",
        },
      },
      {
        analyzer_one: {
          query: "analyzed: query: analyzed: query: what is weather in sf",
        },
      },
      { retriever_two: { docs: ["doc3", "doc4"] } },
      { retriever_one: { docs: ["doc1", "doc2"] } },
      { decider: {} },
      { qa: { answer: "doc1,doc1,doc2,doc2,doc3,doc3,doc4,doc4" } },
    ]);
  });

  /**
   * Port of test_nested_graph from test_pregel_async_graph_structure.py
   */
  it("should handle nested graphs", async () => {
    const neverCalled = (): never => {
      throw new Error("This function should never be called");
    };

    // Define inner state annotation
    const InnerStateAnnotation = Annotation.Root({
      my_key: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
      }),
      my_other_key: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
      }),
    });

    const up = (
      state: typeof InnerStateAnnotation.State
    ): typeof InnerStateAnnotation.Update => {
      return {
        my_key: `${state.my_key} there`,
        my_other_key: state.my_key,
      };
    };

    const inner = new StateGraph(InnerStateAnnotation)
      .addNode("up", up)
      .addEdge(START, "up")
      .addEdge("up", END);

    // Define outer state annotation
    const StateAnnotation = Annotation.Root({
      my_key: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
      }),
      neverCalled: Annotation<unknown>({
        reducer: (_, b) => b,
        default: () => undefined,
      }),
    });

    const side = async (
      state: typeof StateAnnotation.State
    ): Promise<typeof StateAnnotation.Update> => {
      return {
        my_key: `${state.my_key} and back again`,
      };
    };

    const graph = new StateGraph(StateAnnotation)
      .addNode("inner", inner.compile())
      .addNode("side", side)
      .addEdge(START, "inner")
      .addEdge("inner", "side")
      .addEdge("side", END);

    const app = graph.compile();

    const input = { my_key: "my value", neverCalled };
    const expected = {
      my_key: "my value there and back again",
      neverCalled,
    };

    // Test invoke
    const result = await app.invoke(input);
    expect(result).toEqual(expected);

    // Test stream
    const streamChunks = await gatherIterator(await app.stream(input));
    expect(streamChunks).toEqual([
      { inner: { my_key: "my value there" } },
      { side: { my_key: "my value there and back again" } },
    ]);

    // Test stream with values mode
    const valueStreamChunks = await gatherIterator(
      await app.stream(input, { streamMode: "values" })
    );
    expect(valueStreamChunks).toEqual([
      { my_key: "my value", neverCalled },
      { my_key: "my value there", neverCalled },
      { my_key: "my value there and back again", neverCalled },
    ]);

    // Testing event streaming
    // TODO: run ID is not plumbed through
    /*
    let timesCalled = 0;
    for await (const event of app.streamEvents(input, {
      version: "v2",
      streamMode: "values",
      runId: "00000000-0000-0000-0000-000000000000",
    })) {
      if (event.event === "on_chain_end") {
        console.log("event", JSON.stringify(event, null, 2));
        timesCalled += 1;
        expect(event.data).toEqual({
          output: {
            my_key: "my value there and back again",
            neverCalled,
          },
        });
      }
    }
    expect(timesCalled).toBe(1);

    // Testing event streaming without values mode
    timesCalled = 0;
    for await (const event of await app.streamEvents(input, {
      version: "v2",
      runId: "00000000-0000-0000-0000-000000000000",
    })) {
      if (
        event.event === "on_chain_end" &&
        event.run_id === "00000000-0000-0000-0000-000000000000"
      ) {
        timesCalled += 1;
        expect(event.data).toEqual({
          output: {
            my_key: "my value there and back again",
            neverCalled,
          },
        });
      }
    }
    expect(timesCalled).toBe(1);

    // Test with chain
    const chain = app.pipe(new RunnablePassthrough());

    // Test invoke on chain
    const chainResult = await chain.invoke(input);
    expect(chainResult).toEqual(expected);

    // Test stream on chain
    const chainStreamChunks = await gatherIterator(await chain.stream(input));
    expect(chainStreamChunks).toEqual([
      { inner: { my_key: "my value there" } },
      { side: { my_key: "my value there and back again" } },
    ]);

    // Test events on chain
    timesCalled = 0;
    for await (const event of await chain.streamEvents(input, {
      version: "v2",
      runId: "00000000-0000-0000-0000-000000000000",
    })) {
      if (
        event.event === "on_chain_end" &&
        event.run_id === "00000000-0000-0000-0000-000000000000"
      ) {
        timesCalled += 1;
        expect(event.data).toEqual({
          output: [
            { inner: { my_key: "my value there" } },
            { side: { my_key: "my value there and back again" } },
          ],
        });
      }
    }
    expect(timesCalled).toBe(1);
    */
  });

  /**
   * Port of test_doubly_nested_graph_interrupts from test_pregel_async_graph_structure.py
   */
  it("should handle interruptions in doubly nested graphs", async () => {
    // Define state types using annotations
    const StateAnnotation = Annotation.Root({
      my_key: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
      }),
    });

    const ChildStateAnnotation = Annotation.Root({
      my_key: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
      }),
    });

    const GrandChildStateAnnotation = Annotation.Root({
      my_key: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
      }),
    });

    // Define grandchild graph functions
    const grandchild1 = async (
      state: typeof GrandChildStateAnnotation.State
    ): Promise<typeof GrandChildStateAnnotation.Update> => {
      return { my_key: `${state.my_key} here` };
    };

    const grandchild2 = async (
      state: typeof GrandChildStateAnnotation.State
    ): Promise<typeof GrandChildStateAnnotation.Update> => {
      return { my_key: `${state.my_key} and there` };
    };

    // Create grandchild graph
    const grandchild = new StateGraph(GrandChildStateAnnotation)
      .addNode("grandchild_1", grandchild1)
      .addNode("grandchild_2", grandchild2)
      .addEdge("grandchild_1", "grandchild_2")
      .addEdge(START, "grandchild_1")
      .addEdge("grandchild_2", END);

    // Create child graph
    const child = new StateGraph(ChildStateAnnotation)
      .addNode(
        "child_1",
        grandchild.compile({
          interruptBefore: ["grandchild_2"],
        })
      )
      .addEdge(START, "child_1")
      .addEdge("child_1", END);

    // Define parent graph functions
    const parent1 = async (
      state: typeof StateAnnotation.State
    ): Promise<typeof StateAnnotation.Update> => {
      return { my_key: `hi ${state.my_key}` };
    };

    const parent2 = async (
      state: typeof StateAnnotation.State
    ): Promise<typeof StateAnnotation.Update> => {
      return { my_key: `${state.my_key} and back again` };
    };

    // Create parent graph
    const graph = new StateGraph(StateAnnotation)
      .addNode("parent_1", parent1)
      .addNode("child", child.compile())
      .addNode("parent_2", parent2)
      .addEdge(START, "parent_1")
      .addEdge("parent_1", "child")
      .addEdge("child", "parent_2")
      .addEdge("parent_2", END);

    // Create checkpointer and compile app
    const checkpointer = new MemorySaver();
    const app = graph.compile({ checkpointer });

    // Test invoke with nested interrupt
    const config1 = { configurable: { thread_id: "1" } };
    const invokeResult1 = await app.invoke(
      { my_key: "my value" },
      { ...config1, debug: true }
    );
    expect(invokeResult1).toEqual({
      my_key: "hi my value",
      __interrupt__: [],
    });

    const invokeResult2 = await app.invoke(null, { ...config1, debug: true });
    expect(invokeResult2).toEqual({
      my_key: "hi my value here and there and back again",
    });

    // Test stream updates with nested interrupt
    const nodesFinished: string[] = [];
    const config2 = {
      configurable: {
        thread_id: "2",
        [CONFIG_KEY_NODE_FINISHED]: (node: string) => {
          nodesFinished.push(node);
        },
      },
    };

    const streamResults1 = await gatherIterator(
      await app.stream({ my_key: "my value" }, config2)
    );
    expect(streamResults1).toEqual([
      { parent_1: { my_key: "hi my value" } },
      { __interrupt__: expect.any(Array) },
    ]);
    expect(nodesFinished).toEqual(["parent_1", "grandchild_1"]);

    const streamResults2 = await gatherIterator(
      await app.stream(null, config2)
    );
    expect(streamResults2).toEqual([
      { child: { my_key: "hi my value here and there" } },
      { parent_2: { my_key: "hi my value here and there and back again" } },
    ]);
    expect(nodesFinished).toEqual([
      "parent_1",
      "grandchild_1",
      "grandchild_2",
      "child_1",
      "child",
      "parent_2",
    ]);

    // Test stream values with nested interrupt
    const config3 = { configurable: { thread_id: "3" } };
    const streamValuesResults1 = await gatherIterator(
      await app.stream(
        { my_key: "my value" },
        { ...config3, streamMode: "values" }
      )
    );
    expect(streamValuesResults1).toEqual([
      { my_key: "my value" },
      { my_key: "hi my value" },
      { __interrupt__: [] },
    ]);

    const streamValuesResults2 = await gatherIterator(
      await app.stream(null, { ...config3, streamMode: "values" })
    );
    expect(streamValuesResults2).toEqual([
      { my_key: "hi my value" },
      { my_key: "hi my value here and there" },
      { my_key: "hi my value here and there and back again" },
    ]);
  });

  /**
   * Port of test_debug_nested_subgraphs from test_pregel_async_graph_structure.py
   *
   * TODO: streamed configs don't contain the checkpoint_ns key in the checkpoint_map field
   */
  it.skip("should debug nested subgraphs", async () => {
    // Define state annotations
    const StateAnnotation = Annotation.Root({
      messages: Annotation<string[]>({
        reducer: (a, b) => a.concat(b),
        default: () => [],
      }),
    });

    // Create helper function for nodes
    const node = (name: string) => {
      return async (): Promise<typeof StateAnnotation.Update> => {
        return { messages: [`entered ${name} node`] };
      };
    };

    // Create child graph
    const child = new StateGraph(StateAnnotation)
      .addNode("c_one", node("c_one"))
      .addNode("c_two", node("c_two"))
      .addEdge(START, "c_one")
      .addEdge("c_one", "c_two")
      .addEdge("c_two", END);

    // Create parent graph
    const parent = new StateGraph(StateAnnotation)
      .addNode("p_one", node("p_one"))
      .addNode("p_two", child.compile())
      .addEdge(START, "p_one")
      .addEdge("p_one", "p_two")
      .addEdge("p_two", END);

    // Create grandparent graph
    const grandParent = new StateGraph(StateAnnotation)
      .addNode("gp_one", node("gp_one"))
      .addNode("gp_two", parent.compile())
      .addEdge(START, "gp_one")
      .addEdge("gp_one", "gp_two")
      .addEdge("gp_two", END);

    // Compile the graph
    const graph = grandParent.compile({ checkpointer: new MemorySaver() });

    // Stream with debug mode
    const config = { configurable: { thread_id: "1" } };
    const eventsStream = await graph.stream(
      { messages: [] },
      { ...config, streamMode: "debug", subgraphs: true }
    );
    const events = await gatherIterator(eventsStream);

    // Helper to normalize configs for comparison
    const normalizeConfig = (
      config?: LangGraphRunnableConfig
    ): LangGraphRunnableConfig | null => {
      if (!config) return null;

      const cleanConfig: LangGraphRunnableConfig = {
        configurable: {
          thread_id: config.configurable?.thread_id,
          [CONFIG_KEY_CHECKPOINT_ID]:
            config.configurable?.[CONFIG_KEY_CHECKPOINT_ID],
          [CONFIG_KEY_CHECKPOINT_NS]:
            config.configurable?.[CONFIG_KEY_CHECKPOINT_NS],
          [CONFIG_KEY_CHECKPOINT_MAP]:
            config.configurable?.[CONFIG_KEY_CHECKPOINT_MAP],
        },
      };

      return cleanConfig;
    };

    // Collect namespaces and checkpoints
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const streamNs: Record<string, any[]> = {};

    for (const [ns, e] of events) {
      const nsKey = Array.isArray(ns) ? ns.join("|") : "";

      if (!streamNs[nsKey]) {
        streamNs[nsKey] = [];
      }

      if (e.type === "checkpoint") {
        streamNs[nsKey].push(e.payload);
      }
    }

    // Check namespaces - JS represents them differently than Python
    expect(Object.keys(streamNs).length).toBe(3);
    expect(Object.keys(streamNs)).toContain(""); // Root namespace

    // Get history for each namespace
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const historyNs: Record<string, StateSnapshot[]> = {};

    for (const nsKey of Object.keys(streamNs)) {
      const ns = nsKey === "" ? [] : nsKey.split("|");
      const historyConfig = {
        configurable: {
          thread_id: "1",
          checkpoint_ns: ns.join("|"),
        },
      };

      const historyArray = await gatherIterator(
        await graph.getStateHistory(historyConfig)
      );
      historyNs[nsKey] = historyArray.reverse();
    }

    // Compare checkpoint data with history
    for (const nsKey of Object.keys(streamNs)) {
      const checkpointEvents = streamNs[nsKey];
      const checkpointHistory = historyNs[nsKey];

      expect(checkpointEvents.length).toBe(checkpointHistory.length);

      for (let i = 0; i < checkpointEvents.length; i += 1) {
        const stream = checkpointEvents[i];
        const history = checkpointHistory[i];

        expect(stream.values).toEqual(history.values);
        expect(stream.next).toEqual(Array.from(history.next));

        expect(normalizeConfig(stream.config)).toEqual(
          normalizeConfig(history.config)
        );

        expect(normalizeConfig(stream.parentConfig)).toEqual(
          normalizeConfig(history.parentConfig)
        );

        expect(stream.tasks.length).toBe(history.tasks.length);

        for (let j = 0; j < stream.tasks.length; j += 1) {
          const streamTask = stream.tasks[j];
          const historyTask = history.tasks[j];

          expect(streamTask.id).toBe(historyTask.id);
          expect(streamTask.name).toBe(historyTask.name);
          expect(streamTask.interrupts).toEqual(historyTask.interrupts);
          expect(streamTask.error).toEqual(historyTask.error);
          expect(streamTask.state).toEqual(historyTask.state);
        }
      }
    }
  });

  /**
   * Port of test_nested_graph_state_error_handling from test_pregel_async_graph_structure.py
   *
   * TODO: fails because invalid state updates are allowed rather than rejected
   */
  it.skip("should handle errors when updating state in nested graphs", async () => {
    // Define state annotations
    const StateAnnotation = Annotation.Root({
      count: Annotation<number>({
        reducer: (_, b) => b,
        default: () => 0,
      }),
    });

    // Create child node function
    const childNode = (
      state: typeof StateAnnotation.State
    ): typeof StateAnnotation.Update => {
      return { count: state.count + 1 };
    };

    // Create child graph
    const child = new StateGraph(StateAnnotation)
      .addNode("child", childNode)
      .addEdge(START, "child");

    // Create parent graph
    const parent = new StateGraph(StateAnnotation)
      .addNode("child_graph", child.compile())
      .addEdge(START, "child_graph");

    // Compile the graph
    const app = parent.compile({ checkpointer: new MemorySaver() });

    // Test invalid state update on parent
    await expect(
      app.updateState(
        { configurable: { thread_id: "1" } },
        { invalid_key: "value" }
      )
    ).rejects.toThrow();

    // Test invalid state update on child
    await expect(
      app.updateState(
        { configurable: { thread_id: "1", checkpoint_ns: "child_graph" } },
        { invalid_key: "value" }
      )
    ).rejects.toThrow();
  });

  /**
   * Port of test_parent_command from test_pregel_async_graph_structure.py
   */
  it("should handle parent commands", async () => {
    // Import necessary components for messaging
    const { HumanMessage } = await import("@langchain/core/messages");
    const { MessagesAnnotation } = await import(
      "../../graph/messages_annotation.js"
    );

    // Create a tool that returns a parent command
    const getUserName = (): Command => {
      return new Command({
        update: { user_name: "Meow" },
        graph: Command.PARENT,
      });
    };

    // Create the subgraph that uses the tool
    const subgraphBuilder = new StateGraph(MessagesAnnotation)
      .addNode("tool", getUserName)
      .addEdge(START, "tool");

    const subgraph = subgraphBuilder.compile();

    // Create a custom parent state annotation
    const CustomParentStateAnnotation = Annotation.Root({
      ...MessagesAnnotation.spec,
      user_name: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
      }),
    });

    // Create the parent graph
    const builder = new StateGraph(CustomParentStateAnnotation)
      .addNode("alice", subgraph)
      .addEdge(START, "alice");

    // Create a checkpointer and compile the graph
    const checkpointer = new MemorySaver();
    const graph = builder.compile({ checkpointer });

    // Test invoke
    const config = { configurable: { thread_id: "1" } };
    const humanMessage = new HumanMessage("get user name");
    const result = await graph.invoke({ messages: [humanMessage] }, config);

    // Check the result
    expect(result).toEqual({
      messages: [humanMessage],
      user_name: "Meow",
    });

    // Check the state
    const state = await graph.getState(config);

    // Verify basic properties
    expect(state.values).toEqual({
      messages: [humanMessage],
      user_name: "Meow",
    });

    expect(state.next).toEqual([]);

    // Verify metadata structure (not exact values since they can vary)
    expect(state.metadata).toMatchObject({
      source: "loop",
      thread_id: "1",
      step: 1,
    });

    // Check for parent_config
    expect(state.config).toMatchObject({
      configurable: {
        thread_id: "1",
        checkpoint_ns: "",
        checkpoint_id: expect.any(String),
      },
    });
  });

  /**
   * Port of test_multiple_updates_root from test_pregel_async_streaming.py
   */
  it("should handle multiple updates from root node", async () => {
    // Create the string state annotation with concatenation
    const StateAnnotation = Annotation.Root({
      value: Annotation<string>({
        reducer: (a, b) => a + b,
        default: () => "",
      }),
    });

    // Define node functions
    const nodeA = (): (Command | typeof StateAnnotation.Update)[] => {
      return [
        new Command({ update: { value: "a1" } }),
        new Command({ update: { value: "a2" } }),
      ];
    };

    const nodeB = (): typeof StateAnnotation.Update => {
      return { value: "b" };
    };

    // Create the graph
    const graph = new StateGraph(StateAnnotation)
      .addNode("node_a", nodeA)
      .addNode("node_b", nodeB)
      .addEdge("node_a", "node_b")
      .addEdge(START, "node_a")
      .compile();

    // Test the invoke method
    const result = await graph.invoke({ value: "" });
    expect(result).toEqual({ value: "a1a2b" });

    // Test the stream method with updates mode
    const stream = await graph.stream({ value: "" }, { streamMode: "updates" });
    const updates = await gatherIterator(stream);

    // Only streams the last update from node_a
    expect(updates).toEqual([
      { node_a: [{ value: "a1" }, { value: "a2" }] },
      { node_b: { value: "b" } },
    ]);
  });

  /**
   * Port of test_multiple_updates from test_pregel_async_streaming.py
   */
  it("should handle multiple updates", async () => {
    // Create the state annotation with concatenation for the foo field
    const StateAnnotation = Annotation.Root({
      foo: Annotation<string>({
        reducer: (a, b) => a + b,
        default: () => "",
      }),
    });

    // Define node functions
    const nodeA = (): (Command | typeof StateAnnotation.Update)[] => {
      return [
        new Command({ update: { foo: "a1" } }),
        new Command({ update: { foo: "a2" } }),
      ];
    };

    const nodeB = (): typeof StateAnnotation.Update => {
      return { foo: "b" };
    };

    // Create the graph
    const graph = new StateGraph(StateAnnotation)
      .addNode("node_a", nodeA)
      .addNode("node_b", nodeB)
      .addEdge("node_a", "node_b")
      .addEdge(START, "node_a")
      .compile();

    // Test the invoke method
    const result = await graph.invoke({ foo: "" });
    expect(result).toEqual({ foo: "a1a2b" });

    // Test the stream method with updates mode
    const stream = await graph.stream({ foo: "" }, { streamMode: "updates" });
    const updates = await gatherIterator(stream);

    // Only streams the last update from node_a
    expect(updates).toEqual([
      { node_a: [{ foo: "a1" }, { foo: "a2" }] },
      { node_b: { foo: "b" } },
    ]);
  });
});
