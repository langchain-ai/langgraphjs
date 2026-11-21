---
"@langchain/langgraph-checkpoint-postgres": patch
---

Make PostgresStore search pagination deterministic when timestamps or scores tie by ordering tied rows by namespace and key.
