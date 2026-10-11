---
"@langchain/langgraph-checkpoint-mongodb": patch
---

Respect `newVersions` when storing MongoDB checkpoints so unchanged channel values are not written into each checkpoint.
