---
"@langchain/langgraph-checkpoint-sqlite": patch
---

Respect `newVersions` when storing SQLite checkpoints so unchanged channel values are not written into each checkpoint row.
