---
"@langchain/langgraph-checkpoint-redis": patch
---

fix(checkpoint-redis): new channel versions get a random fraction, so two branches from one checkpoint (`updateState` on an older checkpoint, a fork) no longer mint the same version and share a blob, where the second branch's value replaced the first's for every later checkpoint of the first branch.
