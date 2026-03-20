---
"@langchain/langgraph-core": patch
---

Fix `AnyValue.update()` returning `false` instead of `true` when values are received, aligning with all other channel implementations.
