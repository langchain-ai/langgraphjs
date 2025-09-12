---
"@langchain/langgraph-sdk": patch 
---

Add TTL support to ThreadsClient in TypeScript to match Python SDK:

- `threads.create({ ttl })` now accepts either a number (minutes) or an object `{ ttl: number, strategy?: "delete" }`.
- `threads.update(threadId, { ttl })` accepts the same forms.

Numeric TTL values are normalized to `{ ttl, strategy: "delete" }` in the request payload.

