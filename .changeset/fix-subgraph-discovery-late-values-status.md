---
"@langchain/langgraph-sdk": patch
---

fix(sdk): keep subgraph status complete when values arrives late

`SubgraphDiscovery` no longer downgrades a terminal subgraph back to
`running` when a host-namespace `values` snapshot is observed after its
`completed` or `failed` lifecycle event. The content pump and lifecycle
watcher are independent streams, so this reordering could strand nodes as
perpetually running in `useStream` subgraph UIs.
