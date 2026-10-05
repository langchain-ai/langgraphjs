---
"@langchain/langgraph": patch
---

don't ask the checkpointer for the history of a DeltaChannel that was never written; it is empty, and the walk for it read every ancestor of the thread on every load. `updateState` now versions the writes it takes from the head, which also stops PostgresSaver from dropping them, and the snapshot cadence leaves never-written channels alone, so a missing version always means the channel was never written
