---
"@langchain/langgraph": patch
---

Fix "Channel already exists with a different type" error when multiple StateGraphs share field schemas.

This fix adds caching for channel instances in `getChannelsForSchema` to ensure that the same field schema always returns the same channel instance. This prevents false conflicts when `StateGraph._addSchema` compares channels using identity comparison.

This issue commonly occurred when using middleware that adds state fields (like filesystem middleware) in both main agents and subagents.
