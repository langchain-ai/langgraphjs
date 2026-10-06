---
"@langchain/langgraph": patch
---

don't ask the checkpointer for the history of a DeltaChannel that was never written; it is empty, and the walk for it read every ancestor of the thread on every load. Only checkpoints whose metadata has `delta_writes_versioned` skip it: graphs with a DeltaChannel set it on new threads, where every DeltaChannel write has a version, so threads started by earlier versions keep reading as before. `updateState` now versions the writes it takes from the head, which also stops PostgresSaver from dropping them, and keeps the DeltaChannel writes it makes on a new thread.
