---
"@langchain/langgraph": patch
---

don't ask the checkpointer for the history of a DeltaChannel that was never written; it is empty, and the walk for it read every ancestor of the thread on every load
