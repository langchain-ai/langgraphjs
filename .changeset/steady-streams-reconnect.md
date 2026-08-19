---
"@langchain/langgraph-sdk": patch
---

fix(sdk): reconnect thread SSE streams after clean EOF

Treat a clean EOF as an unexpected disconnect while the stream handle is
active, using the existing retry, backoff, and reconnect callback path.
