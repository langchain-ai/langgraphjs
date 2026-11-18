---
"@langchain/langgraph-api": patch
---

The embed server (`createEmbedServer`) now cancels a protocol run that is in flight when `POST /threads/:thread_id/runs/:run_id/cancel` names it, so `useStream().stop()` stops the run on the server. The run ends as `interrupted`, as on the agent server. Before, the route only removed queued runs, and a stopped run kept going and saved its result.
