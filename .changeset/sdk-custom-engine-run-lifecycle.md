---
"@langchain/langgraph-sdk": patch
---

`CustomStreamOrchestrator` reports each run's lifecycle itself, as `StreamOrchestrator` does, so framework bindings don't have to work it out from its state:

- `onCreated` gets the run id from the first `metadata` event of each run's stream. The option was accepted before and never called.
- The new `onRunEnd` option gets `{ runId, reason }` when each run's stream ends, before its `submit()` resolves. The reason is `"interrupt"` when the stream sent an interrupt, `"error"` when it failed, also by timing out, `"stopped"` when it was aborted, as by `stop()` or a thread switch, and `"success"` otherwise. A run the engine's `dispose()` stops isn't reported.
- An `onCreated` or `onRunEnd` that throws is logged, and affects neither the run nor the ones after it.
- Switching to another thread calls `onThreadId`, through `switchThread()`, `syncThreadId()` or `hydrate()`. Before, only a submit that created a thread called it.
- A run that fails or is stopped ends the subagents it left open with an error, as on an Agent Server, instead of leaving them running.
