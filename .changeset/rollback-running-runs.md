---
"@langchain/langgraph-api": patch
---

The `rollback` multitask strategy, and cancelling with `action=rollback`, now roll back a run that is already running, as they already did for a pending one: the run is cancelled, then deleted with its checkpoints, so the next run starts from the state before it, and its stream ends without an error. Before, the run ended as `error` and its writes stayed on the thread.
