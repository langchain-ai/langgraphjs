---
"@langchain/langgraph-sdk": patch
---

fix(sdk): keep isLoading true across interrupt→running hydration

Deferred terminal resets no longer clear isLoading when a newer running lifecycle has already arrived (HITL resume / SSE replay).
