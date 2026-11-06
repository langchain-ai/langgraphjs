---
"@langchain/langgraph-api": patch
---

After a run that forks from a checkpoint, later runs on the thread continue from its latest state again. The dev server saved the fork's `checkpoint_id` (and `checkpoint_ns`, `checkpoint_map` and `run_id`) on the thread config, so every later run on the thread forked from the same checkpoint and dropped the new branch.
