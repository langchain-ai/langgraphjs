---
"@langchain/langgraph-api": patch
---

Thread protocol commands (`POST /threads/:thread_id/commands` and the `/threads/:thread_id/stream/events` WebSocket) now run with the auth of the request or WebSocket connection that sent them, instead of the auth of the first request that touched the thread. A run started over HTTP after a token refresh, or over a WebSocket opened after it, now gets the new token in `config.configurable.langgraph_auth_user`, and run creation, state reads and interrupt answers are authorized as the request that sent them.
