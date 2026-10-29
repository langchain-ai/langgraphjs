---
"@langchain/langgraph-checkpoint": patch
---

`JsonPlusSerializer` stores a `Buffer` as bytes, so it loads back as a `Uint8Array` instead of a `{ type: "Buffer", data }` object.
