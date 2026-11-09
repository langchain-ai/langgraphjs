---
"@langchain/langgraph-api": patch
---

`POST /threads/:thread_id/history` takes `before` as a checkpoint config, as the SDK sends it and the Python Agent Server takes it, so paging with `getHistory({ before })` no longer fails with HTTP 400. A checkpoint ID string still works but is deprecated and will be removed in 2.0.0: send `{ configurable: { checkpoint_id } }` instead.
