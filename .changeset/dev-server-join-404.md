---
"@langchain/langgraph-api": patch
---

`GET /threads/:thread_id/runs/:run_id/join`, and `GET /threads/:thread_id/runs/:run_id/stream` without `Last-Event-ID`, now return HTTP 404 when the run doesn't exist, is on another thread, or is hidden by the `threads:read` handler, as `GET /threads/:thread_id/runs/:run_id` does. `client.runs.join()` and `client.runs.joinStream()` without `lastEventId` then throw `HTTP 404` instead of returning `{ __error__ }` or yielding an error event, while a resume (a join with `Last-Event-ID`) still ends with an error event.
