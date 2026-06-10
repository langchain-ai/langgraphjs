---
"@langchain/langgraph-checkpoint-sqlite": patch
---

fix: `SqliteSaver.putWrites` now honors `WRITES_IDX_MAP`, pinning special channels (`__error__`, `__scheduled__`, `__interrupt__`, `__resume__`) to fixed negative indices instead of the call-local ordinal. Previously a follow-up `putWrites([[INTERRUPT, …]], taskId)` for the same checkpoint silently `REPLACE`d the regular write previously stored at `idx=0` for that task, losing data. The conflict-resolution clause also now matches the Python checkpointer contract: `OR REPLACE` only when every channel is a special one (so e.g. INTERRUPT→RESUME state transitions overwrite), `OR IGNORE` otherwise.
