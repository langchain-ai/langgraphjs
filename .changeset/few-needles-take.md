---
"@langchain/langgraph-sdk": patch
---

Fix `useStream`/`StreamOrchestrator` leaving stale, never-checkpointed messages visible after `stop()` cancels a run mid-turn. The buffer is now reconciled against the persisted thread state (refetching it when the caller needs authoritative thread state, otherwise falling back to the cached history) instead of only clearing on a thread switch or remount.
