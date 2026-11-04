---
"@langchain/langgraph-sdk": patch
---

Add `cancel_reason` to the `Run` type and to `RunSelectField`. The Agent Server returns why a run was cancelled, but callers had to cast to read it.
