---
"@langchain/langgraph-checkpoint": patch
---

Export the store's own `getTextAtPath` and `tokenizePath` from the package entry point. The published helpers were a stale second copy that returned no text for most documented path forms (`"$"`, `"chapters[*].content"`, `"info.age"`, `"array[-1]"`).
