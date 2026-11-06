---
"@langchain/langgraph-checkpoint": patch
---

`JsonPlusSerializer` takes an optional `importMap`, passed to `load`, so a saver can read LangChain objects stored under the legacy `langchain` namespace, such as messages written by Python. It also stores a `Buffer` as bytes, so it loads back as a `Uint8Array` instead of a `{ type: "Buffer", data }` object.
