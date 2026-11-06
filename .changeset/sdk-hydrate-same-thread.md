---
"@langchain/langgraph-sdk": patch
---

fix(sdk): a `hydrate()` of the thread already shown no longer leaves `isLoading` stuck on `true` after the run ends: when it reopens the thread's stream after the connection dropped, when the run ends while it reads the state, or when it finds a run on a thread that was idle. The stream also picks up interrupts raised inside subagents again after it reconnects.
