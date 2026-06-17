---
"@langchain/langgraph": patch
---

fix(langgraph): isolate concurrent singleton-agent invocations by thread

`ensureLangGraphConfig` ignores the ambient `AsyncLocalStorage` `configurable`
on root-level invokes that supply an invoke-time `thread_id` and have no nesting
keys (ignoring graph-bound `.withConfig()` defaults). On a fresh top-level run
the ambient `configurable` can belong to another concurrent invocation, so its
keys — internal scratchpad/task-input as well as user keys like
`tenant_id`/`user_id` — must not leak in; values the caller wants arrive through
the explicit (bound + invoke-time) configs. Ambient nesting (`__pregel_read__`)
and bound child graphs invoked from parent tasks are unaffected. This prevents
cross-invocation leakage between concurrent `invoke()` calls on a shared compiled
graph (e.g. BullMQ workers with `concurrency > 1`). Complements the config-merge
fix that stopped shared graph-bound `metadata`/`configurable` objects from being
mutated across invocations
([#2040](https://github.com/langchain-ai/langgraphjs/issues/2040)).
