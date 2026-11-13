---
"@langchain/langgraph-checkpoint-postgres": patch
---

`PostgresSaver.put` saves a checkpoint and its blobs in one statement instead of a transaction with one INSERT per channel, so it takes one round trip instead of three plus one per changed channel.
