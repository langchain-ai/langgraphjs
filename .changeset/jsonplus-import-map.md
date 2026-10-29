---
"@langchain/langgraph-checkpoint": patch
---

`JsonPlusSerializer` takes an optional `importMap`, passed to `load`, so a saver can read LangChain objects stored under the legacy `langchain` namespace, such as messages written by Python.
