---
"@langchain/langgraph": patch
---

LangGraph's own writers and branch runners inside each node no longer enter an async context. Entering one made `@langchain/core` build a LangSmith run tree on every call, even with tracing off, so graphs whose nodes do little work run up to 1.75x faster. Node functions, edge functions and tools keep their context.
