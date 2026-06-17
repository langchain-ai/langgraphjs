---
"@langchain/langgraph": patch
---

fix(langgraph): isolate concurrent singleton-agent invocations by thread

`ensureLangGraphConfig` strips stale langgraph-internal `configurable` entries
from `AsyncLocalStorage` on root-level invokes with an invoke-time `thread_id`
and no nesting keys (ignoring graph-bound `.withConfig()` defaults), while
preserving user custom configurable keys. Ambient nesting (`__pregel_read__`) and
bound child graphs invoked from parent tasks are unaffected. This prevents scratchpad/task-input leakage between
concurrent `invoke()` calls on a shared compiled graph (e.g. BullMQ workers with
`concurrency > 1`). Complements the config-merge fix that stopped shared
graph-bound `metadata`/`configurable` objects from being mutated across
invocations ([#2040](https://github.com/langchain-ai/langgraphjs/issues/2040)).
