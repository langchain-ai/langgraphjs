---
"@langchain/langgraph-checkpoint-mongodb": patch
---

fix(checkpoint-mongodb): re-check the namespace of `MongoDBStore` vector search results against the requested prefix, so a label like `"team/alice"` can no longer match items stored under `["team", "alice"]`
