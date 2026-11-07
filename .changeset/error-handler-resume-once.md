---
"@langchain/langgraph": patch
---

A node's `errorHandler` that already finished no longer runs again when a sibling's interrupt in the same step is resumed. The handler's saved writes are handed back to it instead, the same way finished nodes get theirs.
