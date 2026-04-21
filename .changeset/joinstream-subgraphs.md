---
"@langchain/langgraph-sdk": patch
---

Add `streamSubgraphs` option to `client.runs.joinStream` and `client.threads.joinStream`.

The server reads `stream_subgraphs` from the request params of the open stream, so reconnecting via `joinStream` without it silently drops all subgraph-namespaced events (e.g. `tasks|my_subgraph:…`) — even if the run was originally created with `streamSubgraphs: true` via `runs.create` / `runs.stream`. Forwarding the flag on `joinStream` matches the behavior of `runs.stream` and lets resumable bridges (the typical production pattern of `runs.create` → `runs.joinStream`) observe subgraph events.
