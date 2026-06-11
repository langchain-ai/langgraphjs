---
"@langchain/langgraph-sdk": patch
---

fix(sdk): reconnect v2 SSE and WebSocket thread streams after disconnect

Add automatic reconnect with resume (`since` for SSE) for protocol transports,
wire `AsyncCaller` through `client.threads.stream`, and expose optional
reconnect tuning on `ThreadStreamOptions`. Includes integration tests against
an in-process mock langgraph-api server.
