---
"@langchain/langgraph": patch
---

Restore per-node `tracePolicy`, using `@langchain/core`'s `TracePolicy` (requires `@langchain/core` >= 1.3.4). It only changes what `LangChainTracer` sends to LangSmith; execution, streaming, and other callbacks see raw values.
