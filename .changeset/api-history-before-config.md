---
"@langchain/langgraph-api": patch
---

fix(api): `POST /threads/{thread_id}/history` takes `before` as a checkpoint config, as the SDK sends it and the Python Agent Server takes it, so paging history with `getHistory({ before })` no longer fails with a 400. A checkpoint ID string still works.
