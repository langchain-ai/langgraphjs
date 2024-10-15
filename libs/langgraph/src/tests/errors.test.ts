/* eslint-disable prefer-template */
import { it, expect } from "@jest/globals";
import {
  Annotation,
  InvalidUpdateError,
  MultipleSubgraphsError,
  StateGraph,
} from "../web.js";
import { MemorySaverAssertImmutable } from "./utils.js";

it("StateGraph concurrent state value update fails", async () => {
  const StateAnnotation = Annotation.Root({
    my_key: Annotation<string>({ reducer: (x: string, y: string) => x + y }),
    market: Annotation<string>,
  });

  const graph = new StateGraph(StateAnnotation)
    .addNode("foo", (_: typeof StateAnnotation.State) => ({
      market: ` slow`,
    }))
    .addNode("bar", (_: typeof StateAnnotation.State) => ({
      market: ` fast`,
    }))
    .addEdge("__start__", "bar")
    .addEdge("__start__", "foo");

  const app = graph.compile();
  let error: InvalidUpdateError | undefined;
  try {
    await app.invoke({ my_key: "value", market: "DE" });
  } catch (e) {
    error = e as InvalidUpdateError;
  }
  expect(error).toBeInstanceOf(InvalidUpdateError);
  expect(error?.code).toEqual("INVALID_CONCURRENT_GRAPH_UPDATE");
});

it("StateGraph bad return type", async () => {
  const StateAnnotation = Annotation.Root({
    my_key: Annotation<string>,
  });

  const graph = new StateGraph(StateAnnotation)
    // @ts-expect-error Test invalid return value
    .addNode("foo", () => "hey")
    .addEdge("__start__", "foo");

  const app = graph.compile({ checkpointer: new MemorySaverAssertImmutable() });
  let error: InvalidUpdateError | undefined;
  try {
    const config = { configurable: { thread_id: "1" } };
    await app.updateState(config, { invalid: "foo" }, "foo");
    await app.invoke({ my_key: "value" }, config);
  } catch (e) {
    error = e as InvalidUpdateError;
  }
  expect(error).toBeInstanceOf(InvalidUpdateError);
  expect(error?.code).toEqual("INVALID_GRAPH_NODE_RETURN_VALUE");
});

it("MultipleSubgraph error", async () => {
  const checkpointer = new MemorySaverAssertImmutable();

  const InnerStateAnnotation = Annotation.Root({
    myKey: Annotation<string>,
    myOtherKey: Annotation<string>,
  });
  const inner1 = async (state: typeof InnerStateAnnotation.State) => {
    return {
      myKey: state.myKey + " here",
      myOtherKey: state.myKey,
    };
  };
  const inner2 = async (state: typeof InnerStateAnnotation.State) => {
    return {
      myKey: state.myKey + " and there",
      myOtherKey: state.myKey,
    };
  };
  const inner = new StateGraph(InnerStateAnnotation)
    .addNode("inner1", inner1)
    .addNode("inner2", inner2)
    .addEdge("__start__", "inner1")
    .addEdge("inner1", "inner2");

  const innerApp = inner.compile({});

  const StateAnnotation = Annotation.Root({
    myKey: Annotation<string>,
    otherParentKey: Annotation<string>,
  });
  const outer1 = async (state: typeof StateAnnotation.State) => {
    return { myKey: "hi " + state.myKey };
  };
  const outer2 = async (state: typeof StateAnnotation.State) => {
    return { myKey: state.myKey + " and back again" };
  };
  const graph = new StateGraph(StateAnnotation)
    .addNode("outer1", outer1)
    .addNode("inner", async (state, config) => {
      await innerApp.invoke(state, config);
      await innerApp.invoke(state, config);
    })
    .addNode("inner2", innerApp)
    .addNode("outer2", outer2)
    .addEdge("__start__", "outer1")
    .addEdge("outer1", "inner")
    .addEdge("outer1", "inner2")
    .addEdge("inner", "outer2");

  const app = graph.compile({ checkpointer });

  await expect(async () =>
    app.invoke({}, { configurable: { thread_id: "foo" } })
  ).rejects.toThrowError(MultipleSubgraphsError);
});
