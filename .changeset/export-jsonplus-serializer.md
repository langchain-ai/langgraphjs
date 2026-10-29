---
"@langchain/langgraph-checkpoint": patch
---

`JsonPlusSerializer`, the serializer every checkpointer uses by default, is now exported, as it is in Python, so a saver that sends checkpoints elsewhere can encode them the same way.
