---
"@langchain/langgraph": patch
---

Give every message saved to a DeltaChannel an id, so `RemoveMessage` can target it: one saved through `updateState`, a plain message object, or one inside an `Overwrite`.
