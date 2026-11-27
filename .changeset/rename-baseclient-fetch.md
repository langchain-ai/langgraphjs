---
"@langchain/langgraph-sdk": patch
---

Rename `BaseClient`'s protected `fetch()` method to `request()` so supply-chain scanners stop reporting each client call as a global `fetch` network access. `fetch()` stays as a deprecated alias, but overriding it no longer intercepts the built-in client calls; use `onRequest` instead.
