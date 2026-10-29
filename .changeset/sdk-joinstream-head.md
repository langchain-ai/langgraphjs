---
"@langchain/langgraph-sdk": patch
---

With history enabled, `joinStream` in the `useStream` hook and `StreamOrchestrator` now shows the thread state read after the joined run ends, as `submit` already does, instead of the joined stream's last values.
