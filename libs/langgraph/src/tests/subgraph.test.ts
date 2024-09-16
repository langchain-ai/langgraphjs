import { describe, it, expect } from "@jest/globals";
import { StateGraph } from "../graph/state.js";
import { Annotation } from "../graph/annotation.js";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { Send } from "../constants.js";
import { FakeTracer } from "./utils.js";

// Define a basic graph and subgraph for testing
function generateTrivialSubgraph() {
  const subgraphState = Annotation.Root({
    substate: Annotation<number>,
  });
  const subgraph = new StateGraph(subgraphState)
    .addNode("subgraphInit", () => ({ substate: 2 }))
    .addNode("subgraphNode", () => ({ substate: 3 }))
    .addNode("subgraphEnd", () => ({ substate: 4 }))
    .addEdge("__start__", "subgraphInit")
    .addEdge("subgraphInit", "subgraphNode")
    .addEdge("subgraphNode", "subgraphEnd")
    .addEdge("subgraphEnd", "__end__");
  return subgraph;
}
function generateTrivialGraph() {
  const StateAnnotation = Annotation.Root({
    substate: Annotation<number>,
    parentstate: Annotation<number>,
  });
  const graph = new StateGraph(StateAnnotation)
    .addNode("parentInit", () => ({ parentstate: 1 }))
    .addNode("afterSubgraph", (state) => ({ parentstate: state.substate }))
    .addEdge("__start__", "parentInit")
    .addEdge("afterSubgraph", "__end__");
  return graph;
}

describe("Subgraphs", () => {
  it.skip("should allow graphs to be added as a node to other graphs", async () => {
    const subgraph = generateTrivialSubgraph();
    const graph = generateTrivialGraph();
    const subgraphRunnable = subgraph.compile();

    const graphRunnable = graph
      .addNode("subgraph", subgraphRunnable)
      .addEdge("parentInit", "subgraph")
      .addEdge("subgraph", "afterSubgraph")
      .compile();

    const output = await graphRunnable.invoke({
      parentstate: 0,
      substate: 0,
    });
    expect(output).toEqual({ parentstate: 4, substate: 4 });
  });

  it("Should interrupt execution for subgraph interruptBefore", async () => {
    const checkpointer = new MemorySaver();
    const subgraph = generateTrivialSubgraph().compile({
      interruptBefore: ["subgraphEnd"],
    });
    const graphRunnable = generateTrivialGraph()
      .addNode("subgraph", subgraph)
      //async (state) => {
      //  const result = await subgraph.invoke(state);
      //  console.log({ result });
      //  return result;
      //})
      .addEdge("parentInit", "subgraph")
      .addEdge("subgraph", "afterSubgraph")
      .compile({ checkpointer });

    // subgraph has its own separate internal state

    // Annotation declares a channels object
    // State isn't an object, it's just the current values of the channels that were declared
    // Passing teh state into a subgraph won't mutate the state passed in.
    const output = await graphRunnable.invoke(
      { parentstate: 0, substate: 0 },
      { configurable: { thread_id: "42" } }
    );
    const state = await graphRunnable.getState({
      configurable: { thread_id: "42" },
    });
    console.log({ state });
    console.log({ output });
    expect(output).toEqual({ parentstate: 1, substate: 3 });
  });
  it.skip("Should interrupt execution for subgraph interruptAfter", async () => {
    const checkpointer = new MemorySaver();
    const subgraph = generateTrivialSubgraph().compile({
      interruptAfter: ["subgraphNode"],
    });
    const graphRunnable = generateTrivialGraph()
      .addNode("subgraph", subgraph)
      .addEdge("parentInit", "subgraph")
      .addEdge("subgraph", "afterSubgraph")
      .compile({ checkpointer });

    const output = await graphRunnable.invoke(
      { parentstate: 0, substate: 0 },
      { configurable: { thread_id: "42" } }
    );
    const state = await graphRunnable.getState({
      configurable: { thread_id: "42" },
    });
    console.log({ state });
    console.log({ output });
    expect(output).toEqual({ parentstate: 1, substate: 2 });
  });
  it.skip("Should resume execution within a subgraph when interrupted there", async () => {
    const checkpointer = new MemorySaver();
    const subgraph = generateTrivialSubgraph().compile({
      interruptBefore: ["subgraphEnd"],
    });
    const graphRunnable = generateTrivialGraph()
      .addNode("subgraph", subgraph)
      .addEdge("parentInit", "subgraph")
      .addEdge("subgraph", "afterSubgraph")
      .compile({ checkpointer });

    const config = { configurable: { thread_id: "42" } };
    const output = await graphRunnable.invoke(
      { parentstate: 0, substate: 0 },
      config
    );
    const state = await graphRunnable.getState(config);
    // Should this be graph:subgraphEnd
    expect(state.next).toBe("subgraphEnd");
    console.log({ state });
    console.log({ output });
    expect(output).toEqual({ parentstate: 1, substate: 2 });
  });

  // implements [this test from python](https://github.com/langchain-ai/langgraph/blob/e8cb6565eec5cf83c90be0ae9528d060ed51a46e/libs/langgraph/tests/test_pregel.py#L9851)
  it.only("can send to nested graphs", async () => {
    const checkpointer = new MemorySaver();

    const OverallState = Annotation.Root({
      subjects: Annotation<string[]>,
      jokes: Annotation<string[]>,
    });

    function continueToJokes(state: typeof OverallState.State) {
      // map each `subject` into a request to the `generate_joke` node with that subject.
      return state.subjects.map(
        (subject) => new Send("generateJoke", { subject })
      );
    }

    const JokeState = Annotation.Root({
      subject: Annotation<string>,
    });

    function edit(state: typeof JokeState.State) {
      return { subject: `${state.subject} - hohoho` };
    }

    // subgraph
    const subgraphBuilder = new StateGraph({
      input: JokeState,
      output: OverallState,
    })
      .addNode("edit", edit)
      .addNode("generate", (state) => ({
        jokes: [`Joke about ${state.subject}`],
      }))
      .addEdge("__start__", "edit")
      .addEdge("edit", "generate")
      .addEdge("generate", "__end__");

    // parent graph
    const graphBuilder = new StateGraph(OverallState)
      .addNode(
        "generateJoke",
        subgraphBuilder.compile({ interruptBefore: ["generate"] })
      )
      .addConditionalEdges("__start__", continueToJokes)
      .addEdge("generateJoke", "__end__");

    const graph = graphBuilder.compile({ checkpointer });
    const tracer = new FakeTracer();
    const config = { configurable: { thread_id: "1", tracer } };

    // invoke and pause at nested interrupt
    const result = await graph.invoke({ subjects: ["cats", "dogs"] }, config);
    console.log("result of nested graph run:", { result });
    expect(result).toEqual({ subjects: ["cats", "dogs"], jokes: [] });
    expect(tracer.runs).toBe(1);
  });
});
