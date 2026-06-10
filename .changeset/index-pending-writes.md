---
"@langchain/langgraph": patch
---

perf(core): index pending writes for O(1) task-prep lookups

Build a PendingWritesIndex once per _prepareNextTasks call so resume and
skip-done-task checks avoid repeated linear scans over checkpointPendingWrites.
