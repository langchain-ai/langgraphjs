---
"@langchain/langgraph": minor
---

feat(langgraph): release an inclusive waiting edge with the nodes that arrived

`addEdge(["a", "b"], "c")` waits for every listed node, so when a conditional edge selects only `a`, `c` never runs, the arrived write is discarded and no error is raised. Add `addEdge([...], target, { inclusive: true })`: the edge waits as long as anything in the graph is running or scheduled, and once the run quiesces it releases with the listed nodes that did complete, running `target` exactly once. The release goes through the barrier's own completeness rule, so the edge stays single-shot and re-arms in loops, and a `Send` in flight is a pending task that holds the release rather than double-firing the target. Edges without the option keep the documented wait-for-all contract; an inclusive edge nobody wrote to stays silent; combining the option with `defer: true` on the target throws at compile.
