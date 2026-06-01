---
"@langchain/langgraph-checkpoint-mongodb": patch
---

fix: metadata filter in list() now works by querying a plain JSON shadow copy instead of the serialized binary blob
