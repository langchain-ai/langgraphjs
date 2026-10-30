---
"@langchain/langgraph-api": patch
---

The dev server's run stream joins (`GET /threads/:thread_id/runs/:run_id/stream`, `GET /runs/:run_id/stream`) now honor `stream_mode` as the Agent Server does, so `client.runs.joinStream(..., { streamMode })` drops other modes' events instead of returning all of the run's events. Errors always pass, and either messages mode keeps both message formats. Joins without `stream_mode` are unchanged.
