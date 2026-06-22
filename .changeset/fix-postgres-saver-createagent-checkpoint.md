---
"@langchain/langgraph-checkpoint": patch
"@langchain/langgraph-checkpoint-postgres": patch
---

fix(langgraph-checkpoint-postgres): prevent createAgent failures with PostgresSaver

Add BaseCheckpointSaver.toJSON() so ConfigurableModel can stringify runnable config without traversing pg Pool timers, and default missing checkpoint maps on load/copy so resume no longer crashes on undefined versions_seen. Closes #1808.
