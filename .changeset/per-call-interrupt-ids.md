---
"@langchain/langgraph": minor
---

feat(langgraph): give each interrupt() in a task its own id

The first `interrupt()` in a task keeps its id, and each later one now gets its own, so strict resume refuses an answer retried after a node asked its next question. Ids saved by older versions still answer: when a resume map has no entry for the task's next interrupt, the first id is used.
