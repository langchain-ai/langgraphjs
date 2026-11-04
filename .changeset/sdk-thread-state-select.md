---
"@langchain/langgraph-sdk": patch
---

`ThreadsClient.getState` and `ThreadsClient.getHistory` accept a `select` option to return only some fields, e.g. `select: ["values.messages"]` to read a single state key. Exports the new `ThreadStateSelectField` type and the existing `ThreadSelectField` type from the package root.
