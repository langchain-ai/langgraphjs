---
"@langchain/langgraph": minor
---

feat(langgraph): document waiting edges and surface unreleased ones

The array overload of `StateGraph.addEdge` had no JSDoc, and a waiting edge whose listed node never runs releases nothing: the arrived writes are discarded, no error is raised, and `getState()` reports an empty `next`. Document the contract on the overload — including how separate edges differ per superstep and the separate-edges-plus-`defer: true` combination that runs a fan-in once with whichever nodes arrived — and add `waitingEdges` to `StateSnapshot`, naming the `target`, the `completed` nodes and the `missing` ones. The key is omitted when every edge released, so a healthy snapshot serialises exactly as before.
