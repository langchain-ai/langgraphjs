---
"@langchain/langgraph-checkpoint": patch
---

Serialize `bigint` values in checkpoints. A `bigint` anywhere in a checkpoint made `JSON.stringify` throw, and the serializer swallowed that into an error string, so the whole checkpoint was saved as `"[unable to serialize, circular reference is too complex to analyze]"` and could not be read back.
