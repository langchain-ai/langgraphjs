---
"@langchain/langgraph": patch
---

fix(langgraph): isolate concurrent singleton-agent invocations by thread

`ensureLangGraphConfig` no longer inherits langgraph-internal `configurable`
entries from `AsyncLocalStorage` when a root-level invoke supplies an invoke-time
`thread_id` without nesting keys (ignoring graph-bound `.withConfig()` defaults).
Ambient nesting (`__pregel_read__`) and bound child graphs invoked from parent
tasks are unaffected. This prevents scratchpad/task-input leakage between
concurrent `invoke()` calls on a shared compiled graph (e.g. BullMQ workers with
`concurrency > 1`). Complements the config-merge fix that stopped shared
graph-bound `metadata`/`configurable` objects from being mutated across
invocations ([#2040](https://github.com/langchain-ai/langgraphjs/issues/2040)).
