---
"@langchain/langgraph-checkpoint": patch
"@langchain/langgraph": patch
---

fix(langgraph): replay concurrent DeltaChannel writes in live order

Concurrent same-superstep writes to a `DeltaChannel` (e.g. a plain write
alongside an `Overwrite`) could reconstruct from a checkpoint differently than
they were applied live, because live execution ordered them by task path while
savers replayed them by task id. `_applyWrites` now applies concurrent delta
writes in the canonical `(task_id, idx)` order, and the base
`getDeltaChannelHistory` walk enforces that same order so reconstruction matches
live for every saver (Postgres, SQLite, MongoDB, Redis, and custom).
