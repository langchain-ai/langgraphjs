---
"@langchain/langgraph-api": minor
---

Pass run context to native Node graph factories through `GraphFactoryConfig.context`. Add `accessContext` to distinguish execution from assistant inspection and thread state operations while preserving the existing single config argument.
