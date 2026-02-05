---
"@langchain/langgraph-checkpoint-mongodb": patch
---

fix(mongodb): validate filter values are primitives

Added validation to ensure filter values in the `list()` method are primitive types
(string, number, boolean, or null).
