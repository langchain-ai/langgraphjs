---
"@langchain/langgraph": patch
---

Prevent checkpointer write failures from surfacing as process-level `unhandledRejection` events before the run boundary reports them.
