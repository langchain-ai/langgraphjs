---
"@langchain/langgraph-checkpoint-sqlite": patch
---

`SqliteSaver.list(config)` now returns only the checkpoint named by `config.configurable.checkpoint_id`. MemorySaver and PostgresSaver both treat that field as the identity of one checkpoint, so `list(config)` yields a single tuple there; this saver ignored it and returned the whole thread history instead.
