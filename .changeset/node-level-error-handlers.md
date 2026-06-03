---
"@langchain/langgraph": minor
---

feat(langgraph): add node-level error handlers

`StateGraph.addNode(name, fn, { errorHandler })` now accepts a first-class
node-level error handler. The handler runs ONLY after the failing node's
`retryPolicy` is exhausted, so retry and handling stay decoupled. It receives a
typed `NodeError { node, error }` and the typed node input state, can return a
state update, and can route to a recovery branch via `new Command({ goto })`
(saga / compensation flows).

Failure provenance is checkpointed (via a reserved `ERROR_SOURCE_NODE` write) so
handlers observe the same context after a checkpoint resume. Uncaught node
errors without a handler still abort the run as before, and `GraphBubbleUp`
errors (such as `interrupt()`) are never swallowed by a handler.

Ports the Python feature from langchain-ai/langgraph#7233.
