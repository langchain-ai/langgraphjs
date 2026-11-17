---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator` now reads a server's `/info` once for every client built with the same config, instead of once per `Client`. An app that builds a `Client` for each thread it shows read `/info` again on every thread it opened. A client with another URL, API key or headers still reads its own. A 404 still means the server has no `/info`, and a read that fails or times out is still read again by the next run that needs it.
