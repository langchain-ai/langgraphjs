---
"@langchain/langgraph-checkpoint-postgres": patch
---

Keep checkpoint blob reads keyed by channel and version so PostgreSQL does not scan every historical blob in the thread and namespace for each checkpoint read.
