---
"@langchain/langgraph-sdk": patch
---

A failed run no longer logs its error with `console.error`, so an app that forwards console errors to a log service no longer gets an extra log for each failed run. The error still reaches the `onError` callbacks. `useStream` from `@langchain/langgraph-sdk/react` gets the same change.
