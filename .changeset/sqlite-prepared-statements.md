---
"@langchain/langgraph-checkpoint-sqlite": patch
---

`SqliteSaver` prepares its `put` and `putWrites` statements once per saver instead of on every call.
