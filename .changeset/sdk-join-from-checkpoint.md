---
"@langchain/langgraph-sdk": minor
---

`client.runs.joinStream` takes a `checkpointId` option, sent as the `checkpoint_id` query parameter: servers that support it send only the run's events after that checkpoint, or the whole run when it is not one of the run's, and other servers ignore it. With `reconnectOnMount`, the `useStream` hook now rejoins a running run once the thread state has loaded, from the loaded head's checkpoint, so a reload no longer replays the run from its start over the state it just loaded. A streamed message now updates the message with its id wherever it is in the list, so one the loaded state already holds, or one a `values` event moved, is not appended again or written over another. `MessageTupleManager.get`'s `defaultIndex` argument and the `index` field of its entries are deprecated: `StreamManager` no longer reads them, and they will be removed in 2.0.
