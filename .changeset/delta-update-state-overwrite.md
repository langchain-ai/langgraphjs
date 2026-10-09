---
"@langchain/langgraph": patch
---

An `Overwrite` through `updateState` snapshots the DeltaChannel it resets on the checkpoint the update saves, as a node's `Overwrite` does in the loop. The value already read back right; reads of that checkpoint and the ones after it no longer walk back past the reset.
