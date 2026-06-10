---
"@langchain/langgraph": patch
---

perf(core): optimize applyWrites, interrupt seen, and channel errors

Reduce allocations in _applyWrites, fix O(N²) interrupt versions_seen updates,
skip stack traces on EmptyChannelError control flow, and cache task lists in
the pregel loop and runner.
