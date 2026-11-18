---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator` now joins the running run a thread load's first lookup finds even when that lookup and the state read both answer before `activate()`. Bindings start the load during a render and call `activate()` from an effect, so this happens whenever the answers are already at hand, for example when an app sent those reads before the engine existed. Such a join was dropped and left to the lookup after the read, a whole runs list later. It is now held for `activate()`, as a join the lookup after the read finds already is, and dropped if that lookup finds no run going.
