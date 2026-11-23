---
"@langchain/langgraph-sdk": patch
---

`useStream` no longer leaves a rejected promise behind when its thread history load fails. The error still reaches `error` and `onError`, but a failed load no longer surfaces as an `unhandledrejection` in the browser or in error monitoring.
