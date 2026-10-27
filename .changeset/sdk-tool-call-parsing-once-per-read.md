---
"@langchain/langgraph-sdk": patch
---

`useStream` no longer re-parses a streaming tool call's arguments on every chunk: messages are converted when the stream values are read, so a long tool call costs one parse per render instead of one per token.
