---
"@langchain/langgraph-sdk": patch
---

Rename `BaseClient`'s protected `fetch()` method to `request()` so supply-chain scanners stop reporting each client call as a global `fetch` network access.
