---
"@langchain/langgraph-api": patch
---

`GET` and `POST /threads/:thread_id/history` honor `select`, as the Python Agent Server does: each state keeps only the fields named, and `values.<key>` keeps one key of the values. An unknown field is rejected with HTTP 400.
