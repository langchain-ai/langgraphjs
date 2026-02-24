---
"@langchain/langgraph-checkpoint-mongodb": minor
---

Add optional `enableTimestamps` parameter to `MongoDBSaver` that sets an `upserted_at` date via MongoDB's `$currentDate` operator on every upsert. Useful for MongoDB TTL indexes, auditing, or debugging.
