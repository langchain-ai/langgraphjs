---
"@langchain/langgraph-sdk": patch
---

A thread run stream from `client.runs.stream()` or `client.runs.joinStream()` that ends without an error and without an `end` or `error` event now asks the server for the run's status. If the run is still pending or running, for example because a proxy timeout or a server restart ended the response, the stream reconnects from the last event as it does after a dropped connection, instead of ending early with a cut answer. A 429, a 5xx or a network error on that check is handled like a dropped connection too. This adds one request at the end of such a stream.
