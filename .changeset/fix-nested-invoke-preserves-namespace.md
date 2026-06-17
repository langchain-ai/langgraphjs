---
"@langchain/langgraph": patch
---

fix(langgraph): preserve namespace nesting for imperative graph invokes

When a compiled graph is invoked from inside another graph's running task
(e.g. a tool body calling `subAgent.invoke(...)`), the surrounding task
context — including the langgraph-internal nesting keys (`__pregel_read`,
`__pregel_stream`, `checkpoint_ns`, the checkpoint map) — is propagated
implicitly via `AsyncLocalStorage`. The base `Runnable.stream` calls
langchain-core's `ensureConfig`, which replaces the ambient `configurable`
wholesale whenever the caller passes its own. Because `createAgent` always
supplies a `configurable`, every tool-invoked sub-agent lost those keys, ran
as a fresh root run, and had its streamed events flattened to the root
namespace instead of nesting under the triggering task.

`Pregel.stream` now merges the ambient `configurable` underneath the caller's
(caller keys win per-key) when the ambient marks an active task
(`__pregel_read` present) but the explicit `configurable` is missing it.
Declared subgraph nodes (which already carry their own `__pregel_read`) and
top-level runs are unaffected.
