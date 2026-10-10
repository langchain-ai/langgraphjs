---
"@langchain/langgraph": patch
---

An exit-durability run that starts from a checkpoint the thread has moved past, addressed by `checkpoint_id`, no longer stores its `DeltaChannel` writes on that checkpoint, where the branch that already grew from it read them too. The run now snapshots the channels it wrote instead.
