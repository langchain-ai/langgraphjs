---
"@langchain/langgraph-checkpoint-mongodb": minor
---

Add optional `ttlMs` parameter to `MongoDBSaver` that writes an `expires_at` BSON date to documents, enabling automatic expiration via MongoDB TTL indexes.
