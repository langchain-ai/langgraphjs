---
"@langchain/langgraph-api": patch
---

`GET /threads/:thread_id/state`, `GET /threads/:thread_id/state/:checkpoint_id` and `POST /threads/:thread_id/state/checkpoint` honor `select`, as `/history` does: the state keeps only the fields named, and `values.<key>` keeps one key of the values. An unknown field is rejected with HTTP 400.
