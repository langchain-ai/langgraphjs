import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { Annotation } from "../graph/index.js";
import { StateGraph } from "../graph/state.js";
import { END, START } from "../constants.js";

const State = Annotation.Root({
  count: Annotation<number>,
});

function createLoopingGraph() {
  return new StateGraph(State)
    .addNode("increment", (state) => ({ count: state.count + 1 }))
    .addEdge(START, "increment")
    .addConditionalEdges("increment", (state) =>
      state.count < 10 ? "increment" : END
    )
    .compile();
}

describe("recursionLimit inside configurable", () => {
  let warn: MockInstance<typeof console.warn>;

  const recursionLimitWarnings = () =>
    warn.mock.calls.filter(([message]) =>
      String(message).includes(`"recursionLimit"`)
    );

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("warns on invoke and still applies the default limit", async () => {
    const result = await createLoopingGraph().invoke(
      { count: 0 },
      { configurable: { recursionLimit: 5 } }
    );

    expect(result.count).toBe(10);
    expect(recursionLimitWarnings()).toHaveLength(1);
    expect(recursionLimitWarnings()[0][0]).toContain("{ recursionLimit: 5 }");
  });

  it("warns on stream", async () => {
    const stream = await createLoopingGraph().stream(
      { count: 0 },
      { configurable: { recursionLimit: 5 } }
    );
    for await (const _ of stream) {
      // Drain the stream.
    }

    expect(recursionLimitWarnings()).toHaveLength(1);
  });

  it("warns once when the graph has a subgraph", async () => {
    const subgraph = createLoopingGraph();
    const graph = new StateGraph(State)
      .addNode("subgraph", subgraph)
      .addEdge(START, "subgraph")
      .compile();

    await graph.invoke({ count: 0 }, { configurable: { recursionLimit: 5 } });

    expect(recursionLimitWarnings()).toHaveLength(1);
  });

  it("does not warn for a top-level recursionLimit", async () => {
    await expect(
      createLoopingGraph().invoke({ count: 0 }, { recursionLimit: 5 })
    ).rejects.toThrow("Recursion limit of 5 reached");

    expect(recursionLimitWarnings()).toHaveLength(0);
  });
});
