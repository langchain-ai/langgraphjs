---
"@langchain/langgraph-sdk": minor
"@langchain/langgraph-api": patch
---

Export the native Agent Server graph factory `ServerRuntime` type from `@langchain/langgraph-sdk`. The server uses the same definition, requires SDK 1.13.0 or later, and retains the existing `@langchain/langgraph-api/graph` export. The runtime contract is unchanged: runs and resumes receive `executionRuntime.context`, and assistant inspection and thread state operations receive `executionRuntime: null`.
