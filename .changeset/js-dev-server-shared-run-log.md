---
"@langchain/langgraph-api": patch
---

The dev server no longer splits a run's events between the clients reading it. A run created without `stream_resumable` kept its events in a queue that each read emptied, so two clients joining the run each got only part of them, and `runs.join()` took events away from a stream still open on the run. Every run now keeps its events, as resumable runs already did, and each reader reads them from its own position: the request that creates a streamed run, `runs.wait()` and `runs.join()` read the run from the start, a join with `Last-Event-ID` resumes after that event, and a join without one gets the events published after it joins. Before, such a join got whatever events no other reader had taken yet. To read a run from the start, pass `lastEventId: "-1"` to `client.runs.joinStream()`. A run's events stay in memory until the server restarts, as a resumable run's events already did.
