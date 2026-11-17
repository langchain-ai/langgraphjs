---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator` now shares a server's `/info` read for 5 minutes among the clients built with the same config, instead of reading it once per `Client`. An app that builds a `Client` for each thread it shows read `/info` again on every thread it opened. A client with another URL, API key or headers still reads its own. A 404 still means the server has no `/info`, and a read that fails or times out is still read again by the next run that needs it.
