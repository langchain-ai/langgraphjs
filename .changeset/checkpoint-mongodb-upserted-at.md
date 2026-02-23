---
"@langchain/langgraph-checkpoint-mongodb": minor
---

Add optional `enableTimestamps` parameter to `MongoDBSaver` that writes an `updated_at` BSON date to documents on every upsert. Useful for MongoDB TTL indexes, auditing, or debugging.
