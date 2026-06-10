---
"@langchain/langgraph": patch
---

fix(schema): expose StateSchema JSON schemas for Studio introspection

Route StateSchema runtime definitions through getJsonSchema() and
getInputJsonSchema() so LangGraph Studio receives state, input, and
context schemas when graphs use the StateSchema primitive.

Fixes #2466
