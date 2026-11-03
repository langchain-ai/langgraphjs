---
"@langchain/langgraph-sdk": patch
---

`ThreadsClient.getState` and `ThreadsClient.getHistory` accept a `select` option to return only some fields, e.g. `select: ["values.messages"]` to read a single state key. Adds the `ThreadStateSelectField` type.
