---
"@langchain/langgraph-checkpoint-redis": patch
---

Prevent concurrent shallow checkpoint writes from replacing a newer checkpoint or losing its writes marker.
