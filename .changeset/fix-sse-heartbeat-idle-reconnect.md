---
"@langchain/langgraph-sdk": patch
---

fix(sdk): reconnect SSE streams when heartbeat idle is detected

Detect half-open SSE connections by watching for server keep-alive heartbeats (`: heartbeat`) and reconnecting with Last-Event-ID or `since` when they stop. `"auto"` mode arms only after heartbeats are observed, so long tool calls and HITL pauses do not false-fire on heartbeat-emitting servers.
