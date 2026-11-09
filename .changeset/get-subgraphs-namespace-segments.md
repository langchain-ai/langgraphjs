---
"@langchain/langgraph": patch
---

match whole namespace segments in `getSubgraphs` and `getSubgraphsAsync`, so a `namespace` such as `research_review` no longer also yields `research|review`, and yield a namespace's subgraph once when a node declares several `subgraphs`
