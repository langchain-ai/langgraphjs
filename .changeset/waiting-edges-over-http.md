---
"@langchain/langgraph-api": patch
"@langchain/langgraph-sdk": patch
---

feat(langgraph-api): carry waiting edges into the thread-state payload

`stateSnapshotToThreadState` maps the snapshot to the HTTP payload with an explicit field list, so `waitingEdges` stopped at the process boundary and `client.threads.getState()` could not see an edge that never released. Map it as `waiting_edges`, matching the payload's snake_case, and add the field to the SDK's `ThreadState`. The key is omitted when every edge released, so an existing payload keeps its shape.
