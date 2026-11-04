---
"@langchain/langgraph": minor
---

feat(langgraph): give each interrupt() in a task its own id

An interrupt raised after its task already got answers now gets its own id: the namespace hash plus the answer count. A task's first question keeps its id, and strict resume refuses an answer retried after a node asked its next question. Ids saved by older versions still answer: when a resume map has no entry for the task's next interrupt, the first id is used. A node retried by its retry policy now reuses its task's answers instead of asking again.
