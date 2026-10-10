---
"@langchain/langgraph": patch
---

feat(langgraph): surface a subgraph's unreleased waiting edges

`getState` describes one checkpoint namespace, so an edge left waiting inside a subgraph was invisible from the parent even though the child's checkpoint holds it. Collect those under `subgraphs: true`, tagged with the stable subgraph node `path` and the exact `namespace`; `missing` is derived from the channel name, and a looped subgraph reports once per edge rather than once per invocation. A graph with no subgraph node skips the search entirely.
