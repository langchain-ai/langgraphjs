---
"@langchain/langgraph-checkpoint": patch
---

`MemorySaver.getDeltaChannelHistory` reads from the thread's latest checkpoint when the config has no `checkpoint_id`, like `getTuple` and the other savers. It returned no seed and no writes before. Graphs always pass a checkpoint id, so only direct callers were affected.
