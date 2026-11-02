---
"@langchain/langgraph-sdk": patch
---

`client.runs.joinStream` takes a `checkpointId` option, sent as the `checkpoint_id` query parameter: servers that support it send only the run's events after this checkpoint, or the whole run when it is not one of the run's, and other servers ignore it. With `reconnectOnMount`, the `useStream` hook now waits for the thread state to load before it rejoins a running run, and passes the loaded head's checkpoint. On those servers, a reload no longer sends the screen back to the start of the run to replay it over the state it just loaded.
