---
"@langchain/langgraph-api": patch
---

`GET /threads/:thread_id/runs/:run_id/stream` now ends with a `Run not found` error unless the run exists and is on that thread, where it used to stream a run on any thread. A join that arrives after its run was deleted (by `DELETE /threads/:thread_id/runs/:run_id` or a rollback) gets that error too, as `GET /threads/:thread_id/runs/:run_id` does, instead of the deleted run's events. When the `threads:read` handler returns filters, `GET /runs/:run_id/stream` streams only a run that exists and whose thread matches them, and ends with no events otherwise, so a stateless run can be joined that way only until it ends.
