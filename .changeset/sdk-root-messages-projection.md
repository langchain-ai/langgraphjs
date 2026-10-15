---
"@langchain/langgraph-sdk": patch
---

`messagesProjection([])`, the root-namespace messages projection acquired through `StreamController.registry`, now fills from the root event stream. It threw a `ReferenceError` on every event and stayed empty. The framework hooks were not affected: `useMessages` returns `stream.messages` for the root.
