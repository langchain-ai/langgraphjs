---
"@langchain/langgraph": patch
---

fix(langgraph): a DeltaChannel no longer reads back writes from another branch. The first checkpoint of a new branch snapshots the delta channels its base has pending writes for, an `updateState` on a checkpoint the thread moved past stores none of its writes there, and a replay of such a checkpoint forks before storing a `Command`'s writes.
