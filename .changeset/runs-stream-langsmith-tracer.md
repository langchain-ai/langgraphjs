---
"@langchain/langgraph-sdk": patch
---

Send `langsmith_tracer` in the `runs.stream()` request body, so LangSmith trace routing set on a streaming run reaches the server instead of being silently dropped. Matches `runs.create()` and `runs.wait()`, which already send it.
