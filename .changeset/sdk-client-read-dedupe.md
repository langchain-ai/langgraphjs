---
"@langchain/langgraph-sdk": patch
---

fix(sdk): coalesce duplicate thread read requests

Coalesce concurrent identical `threads.getState()` and `threads.getHistory()` reads within the SDK client so transient remounts do not issue duplicate hydrate requests. Request identity includes the prepared URL, body, method, and headers, and coalescing is skipped for caller-provided abort signals, raw response reads, and `onRequest` hooks to preserve auth and cancellation isolation.
