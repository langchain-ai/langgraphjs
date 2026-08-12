---
"@langchain/langgraph": minor
---

feat(langgraph): document waiting edges and surface unreleased ones

The array overload of `StateGraph.addEdge` had no JSDoc, so the only statement of its contract was Python's `add_edge` docstring, and the two spellings of a fan-in are not interchangeable: a waiting edge is triggered once for the whole set of listed nodes, while separate edges into the same target trigger once per superstep in which any of them completes. Document both, along with what follows when a listed node never runs — the edge is not triggered, no error is raised, and nodes downstream are skipped unless they have another live path. Add `waitingEdges` to `StateSnapshot` for the same condition at runtime, naming the target, the nodes that completed and the nodes that never ran, so an empty `next` alongside a non-empty entry tells a stuck run from a finished one. Read an entry as "these writes were dropped" rather than "this node never ran", since a loop or a `Send` can reach the target without the edge. The key is omitted when every edge released, so healthy snapshots keep their existing shape.
