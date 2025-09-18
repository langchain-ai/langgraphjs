---
"@langchain/langgraph": patch
---

Add `stream.encoding` option to emit LangGraph API events as Server-Sent Events. This allows for sending events through the wire by piping the stream to a `Response` object.
