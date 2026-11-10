---
"@langchain/langgraph-sdk": patch
---

fix(sdk): `useStream` from `@langchain/langgraph-sdk/react` now calls the `onError` passed to `submit()` when that run fails, after the hook's own `onError`. It was typed and documented but never called, on both the LangGraph server and the custom `transport` paths.
