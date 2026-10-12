---
"@langchain/langgraph": patch
---

Give every message written to a DeltaChannel that uses `messagesDeltaReducer` an id, so `RemoveMessage` can target it: one saved through `updateState`, a string, a `[role, content]` pair, a plain object, one inside an `Overwrite`, a raw `Pregel` input, or a `Command` forked from an older checkpoint.
