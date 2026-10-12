---
"@langchain/langgraph-checkpoint-postgres": patch
---

fix(checkpoint-postgres): new channel versions get a random fraction, so two branches from one checkpoint (`updateState` on an older checkpoint, a fork) no longer mint the same version and share a blob, where the second branch read back the first one's value.
