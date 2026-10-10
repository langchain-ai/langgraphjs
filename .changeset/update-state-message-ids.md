---
"@langchain/langgraph": patch
---

Give a message saved through `updateState` to a DeltaChannel an id, as a node's messages get, so every read returns the same id.
