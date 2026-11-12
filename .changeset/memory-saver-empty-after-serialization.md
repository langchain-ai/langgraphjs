---
"@langchain/langgraph-checkpoint": patch
---

Return no checkpoint from MemorySaver when a failed first serialization leaves an empty namespace, allowing reads and a later successful put to recover.
