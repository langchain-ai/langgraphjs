---
"@langchain/langgraph": patch
---

List a `ToolNode`'s tool names under the `__tools` node metadata key in `getGraph()` and `getGraphAsync()`, matching Python, so graph viewers such as Studio can show which tools it runs.
