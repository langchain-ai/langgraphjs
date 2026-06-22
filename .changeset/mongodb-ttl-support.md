---
"@langchain/langgraph-checkpoint-mongodb": minor
---

Add TTL support for automatic checkpoint expiration

- Add optional `ttl` parameter to MongoDBSaver (value in seconds)
- Add `setup()` method to create TTL indexes on collections
- Add `upserted_at` timestamp to documents when TTL is enabled
- Each write refreshes TTL (expires after inactivity, not creation)
