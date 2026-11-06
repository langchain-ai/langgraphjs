---
"@langchain/langgraph-checkpoint": patch
"@langchain/langgraph": patch
---

Keep new checkpoint UUIDs after their parent when continuing a thread from another process whose clock is behind. Preserve monotonic ordering when the local clock rolls back or the sub-millisecond counter overflows.
