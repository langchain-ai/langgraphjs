---
"@langchain/langgraph-api": patch
---

The experimental embed server's run stream join (`GET /threads/:thread_id/runs/:run_id/stream`) now honors `stream_mode` like the dev server's joins, so `client.runs.joinStream(..., { streamMode })` drops other modes' events and the `metadata` event instead of returning all of the run's events. Errors always pass, and either messages mode keeps both message formats. Joins without `stream_mode` are unchanged.
