---
"@langchain/langgraph": patch
---

fix(state): validate Zod state updates from nodes

Validate node return values and Command updates against Zod state schema
constraints before applying them to graph state.

Fixes #2519
