---
"@langchain/langgraph-checkpoint-mongodb": minor
---

feat: add MongoDBStore for long-term memory

New `MongoDBStore` class for persisting data across threads and sessions — user preferences, learned facts, agent memory, and more.

- Store and retrieve JSON documents organized by hierarchical namespaces
- Search with field-based filtering and comparison operators
- Vector similarity search with manual embedding (bring your own embedding model) or auto embedding (MongoDB generates embeddings via Voyage AI)
- Automatic document expiration via configurable TTL
