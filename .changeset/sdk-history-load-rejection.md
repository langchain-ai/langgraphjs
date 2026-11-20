---
"@langchain/langgraph-sdk": patch
---

fix(sdk): `useStream` from `@langchain/langgraph-sdk/react` no longer leaves an unhandled rejection when the thread fails to load, for example on a 404. The hook already returns that failure as `error` and passes it to `onError`.
