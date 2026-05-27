---
"@langchain/langgraph-sdk": patch
---

fix(sdk): preserve apiUrl path prefix in stream transport URLs

Use BaseClient-style URL concatenation in `toAbsoluteUrl` so SSE and WebSocket
subscriptions work when the SDK is pointed at a proxied apiUrl with a path
prefix (e.g. `/api/chat-langchain`).
