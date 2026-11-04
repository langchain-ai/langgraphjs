---
"@langchain/langgraph": patch
---

`getState()` no longer reports an interrupt that was already answered. When one of several parallel tasks is resumed by interrupt id, the latest state now lists only the interrupts that are still pending, matching the `__interrupt__` of the `invoke()` result. The task that finished shows its `result` instead. History and explicit-checkpoint reads still show the interrupts as they were recorded.
