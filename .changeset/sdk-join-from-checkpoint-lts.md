---
"@langchain/langgraph-sdk": patch
---

`client.runs.joinStream` takes a `checkpointId` option, sent as the `checkpoint_id` query parameter: servers that support it send only the run's events after that checkpoint, or the whole run when it is not one of the run's, and other servers ignore it. With `reconnectOnMount`, `useStream` now rejoins a running run once the thread state has loaded, from the loaded head's checkpoint, so a reload no longer replays the run from its start over the state it just loaded. A streamed message whose id the loaded state already holds now updates that message instead of being appended again.
