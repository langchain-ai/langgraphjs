---
"@langchain/langgraph-checkpoint": patch
---

Improve `MemorySaver` diagnostics when checkpoint writes are missing a
`thread_id`.

The in-memory checkpointer now explains why `configurable.thread_id` is
required and includes a concrete `graph.stream(..., { configurable: {
thread_id } })` example in the error message. This makes the new
thread-oriented event streaming flows easier to debug when an application
forgets to provide durable thread configuration.
