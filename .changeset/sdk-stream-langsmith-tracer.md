---
"@langchain/langgraph-sdk": patch
---

fix(sdk): `runs.stream` sends `_langsmithTracer` as `langsmith_tracer`, like `runs.create` and `runs.wait` already do, so a streamed run is traced to the requested LangSmith project instead of the default one.
