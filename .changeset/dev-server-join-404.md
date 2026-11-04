---
"@langchain/langgraph-api": patch
---

`GET /threads/:thread_id/runs/:run_id/join` and `GET /threads/:thread_id/runs/:run_id/stream` now return HTTP 404 when the run doesn't exist, is on another thread, or is hidden by the `threads:read` handler, as `GET /threads/:thread_id/runs/:run_id` does. `client.runs.join()` and `client.runs.joinStream()` then throw `HTTP 404` instead of returning `{ __error__ }` or yielding an error event, with or without `lastEventId`.
