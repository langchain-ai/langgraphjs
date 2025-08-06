/* eslint-disable prefer-template */
import { it, expect } from "vitest";
import {
  Annotation,
  END,
  InvalidUpdateError,
  START,
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
  expect(error?.lc_error_code).toEqual("INVALID_CONCURRENT_GRAPH_UPDATE");
});

it("StateGraph bad return type", async () => {
  const StateAnnotation = Annotation.Root({
    my_key: Annotation<string>,
  });

  const graph = new StateGraph(StateAnnotation)
    // @ts-expect-error Test invalid return value
    .addNode("foo", () => ({ my_key: true }))
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
  expect(error?.lc_error_code).toEqual("INVALID_GRAPH_NODE_RETURN_VALUE");
});

it("Should throw errors in conditional edges", async () => {
  class TestError extends Error {}

  const StateAnnotation = Annotation.Root({
    myKey: Annotation<string>,
  });

  const graph = new StateGraph(StateAnnotation)
    .addNode("init", (state) => state)
    .addNode("x", (state) => state)
    .addEdge(START, "init")
    .addConditionalEdges("init", () => {
      throw new TestError();
    })
    .addEdge("x", END);

  const app = graph.compile({ checkpointer: new MemorySaverAssertImmutable() });

  await expect(
    app.invoke({}, { configurable: { thread_id: "1" } })
  ).rejects.toThrow(TestError);
});
