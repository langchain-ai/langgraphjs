---
"@langchain/langgraph-checkpoint": patch
---

Use locale-independent checkpoint ID ordering in `MemorySaver.getTuple`, `list`, and `getDeltaChannelHistory`, consistent with UUID6 timestamp order and the `before` filter.
