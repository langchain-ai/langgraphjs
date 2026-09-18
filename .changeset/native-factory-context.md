---
"@langchain/langgraph-api": minor
---

Pass a typed `ServerRuntime` as the second graph factory argument. Runs and resumes receive `executionRuntime.context`; assistant inspection and thread state operations receive `executionRuntime: null`. Existing config-only factories remain supported.
