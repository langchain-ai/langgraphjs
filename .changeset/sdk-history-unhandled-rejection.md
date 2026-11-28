---
"@langchain/langgraph-sdk": patch
---

`useStream` no longer produces an unhandled promise rejection when the initial thread history load fails. The error was already recorded in state and reported through `onError`; the fire-and-forget effect now swallows the redundant rejection instead of surfacing it in the browser console.
