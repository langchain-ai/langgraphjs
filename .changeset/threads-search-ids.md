---
"@langchain/langgraph-sdk": patch
"@langchain/langgraph-api": minor
---

feat(threads): add `ids` filter to Threads.search

- SDK: `ThreadsClient.search` now accepts `ids?: string[]` and forwards it to `/threads/search`.
- API: `/threads/search` schema accepts `ids` and storage filters by provided thread IDs.

This enables fetching a specific set of threads directly via the search endpoint, while remaining backward compatible.

