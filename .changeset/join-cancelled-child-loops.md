---
"@langchain/langgraph": patch
---

Wait for cancelled nested graph finalizers before reporting task completion, so exit durability preserves completed child-node writes across sibling failures and resume.
