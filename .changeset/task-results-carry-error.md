---
"@langchain/langgraph": patch
---

Task results in the `tasks` and `debug` stream modes carry the task's `error` (`null` when it succeeded), as they do in Python, so a failed task no longer looks completed.
