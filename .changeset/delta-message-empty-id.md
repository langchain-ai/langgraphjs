---
"@langchain/langgraph": patch
---

A message object written to a messages `DeltaChannel` with `id: ""` now gets an id, as plain objects and strings already did. Before, two such messages in one write collapsed into one.
