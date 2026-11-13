---
"@langchain/langgraph-checkpoint-postgres": patch
---

`PostgresSaver.putWrites` saves a task's writes in one statement instead of a transaction with one INSERT per write, so it takes one round trip instead of two plus one per write.
