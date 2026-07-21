---
"@langchain/langgraph-sdk": patch
---

Fix `useStream` crash (`TypeError: Cannot read properties of null (reading 'fetch')`) when a thread is cleared while hydration is in flight. The stale hydrate now bails immediately after the `getState()` await — it no longer applies the fetched state to the thread that was left, nor opens a reconnect via `threads.stream(null, …)`.
