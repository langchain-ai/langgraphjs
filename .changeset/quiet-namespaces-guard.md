---
"@langchain/langgraph-checkpoint": patch
"@langchain/langgraph-checkpoint-postgres": patch
---

Reject colons and NUL bytes in shared store namespace labels, and reject NUL bytes in PostgreSQL store namespace labels before CRUD queries.
