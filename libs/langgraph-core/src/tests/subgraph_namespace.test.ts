/**
 * Finding the subgraph a namespace names, such as `research|review`.
 */
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { describe, expect, it } from "vitest";

import { START } from "../constants.js";
import { Annotation, StateGraph } from "../graph/index.js";
import { gatherIterator } from "../utils.js";

const NotesState = Annotation.Root({
  notes: Annotation<string>,
});

function notesGraph(label: string) {
  return new StateGraph(NotesState)
    .addNode("work", () => ({ notes: label }))
    .addEdge(START, "work")
    .compile();
}

/**
 * A parent whose subgraph namespaces start with one another's names:
 * `research` has a `review` subgraph, and the parent declares
 * `research_review` and `review` too. Returns the parent and each subgraph,
 * keyed by its namespace.
 */
function prefixNamedSubgraphs() {
  const researchReview = notesGraph("research's review");
  const graphs = {
    "research|review": researchReview,
    research_review: notesGraph("research_review"),
    review: notesGraph("review"),
    research: new StateGraph(NotesState)
      .addNode("review", researchReview)
      .addEdge(START, "review")
      .compile(),
  };
  const parent = new StateGraph(NotesState)
    .addNode("research", graphs.research)
    .addNode("research_review", graphs.research_review)
    .addNode("review", graphs.review)
    .addEdge(START, "research")
    .addEdge("research", "research_review")
    .addEdge("research_review", "review")
    .compile();
  return { parent, graphs };
}

describe("getSubgraphsAsync with a namespace", () => {
  // `research_review` isn't `research` then `review`, and `research|review`
  // doesn't also find the parent's own `review`.
  it.each([
    "research",
    "research|review",
    "research_review",
    "review",
  ] as const)("yields only the subgraph at %s", async (namespace) => {
    const { parent, graphs } = prefixNamedSubgraphs();

    const found = await gatherIterator(
      parent.getSubgraphsAsync(namespace, true)
    );

    expect(found.map(([name]) => name)).toEqual([namespace]);
    expect(found[0][1]).toBe(graphs[namespace]);
  });

  it("yields one subgraph when a node declares several", async () => {
    const inner = notesGraph("first's inner");
    const wrap = (graph: typeof inner) =>
      new StateGraph(NotesState)
        .addNode("inner", graph)
        .addEdge(START, "inner")
        .compile();
    const parent = new StateGraph(NotesState)
      .addNode("multi", () => ({}), {
        subgraphs: [wrap(inner), wrap(notesGraph("second's inner"))],
      })
      .addEdge(START, "multi")
      .compile();

    const found = await gatherIterator(
      parent.getSubgraphsAsync("multi|inner", true)
    );

    expect(found.map(([name]) => name)).toEqual(["multi|inner"]);
    expect(found[0][1]).toBe(inner);
  });
});

describe("updateState on a nested namespace", () => {
  // `research|review` names a `review` inside `research`'s subgraph, which
  // declares no subgraph there. The update throws rather than writing through
  // the parent's own `review`.
  it("throws despite a top-level namesake", async () => {
    const research = new StateGraph(NotesState)
      .addNode("review", () => ({}))
      .addEdge(START, "review")
      .compile();
    const parent = new StateGraph(NotesState)
      .addNode("research", research)
      .addNode("review", notesGraph("review"))
      .addEdge(START, "research")
      .addEdge("research", "review")
      .compile({ checkpointer: new MemorySaver() });
    const config = {
      configurable: { thread_id: "1", checkpoint_ns: "research:a|review:b" },
    };

    await expect(
      parent.updateState(config, { notes: "edit" })
    ).rejects.toThrow('Subgraph "research|review" not found');
  });
});
