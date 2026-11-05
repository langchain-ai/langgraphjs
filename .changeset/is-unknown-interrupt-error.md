---
"@langchain/langgraph": patch
---

feat(langgraph): add `isUnknownInterruptError`, which matches the error by name like `isGraphInterrupt`, so it also recognizes an `UnknownInterruptError` thrown by another copy of `@langchain/langgraph`
