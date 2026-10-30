---
"@langchain/langgraph-sdk": patch
---

A headless tool call still waiting for its result when a thread opens, for example after a page reload, now runs once and resumes the run in the `useStream` hook and `StreamOrchestrator`; before, nothing ran and the thread stayed paused. Effects replayed by StrictMode, Fast Refresh or `<Activity>` no longer run a pending headless tool twice in the hook, nor, under Fast Refresh or `<Activity>`, with a custom `transport`.
