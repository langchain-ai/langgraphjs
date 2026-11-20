---
"@langchain/langgraph-checkpoint-sqlite": patch
---

fix(langgraph-checkpoint-sqlite): list only the checkpoint named by the config's `checkpoint_id`

`SqliteSaver.list()` ignored `checkpoint_id` in the config and returned every checkpoint in the thread. It now filters on it, like `MemorySaver`, `PostgresSaver` and the Python `SqliteSaver`.
