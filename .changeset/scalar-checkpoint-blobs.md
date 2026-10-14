---
"@langchain/langgraph-checkpoint-postgres": patch
---

Read checkpoint blobs and pending writes as scalar bytea rows to avoid excessive memory use and process crashes in the PostgreSQL text-array parser.
