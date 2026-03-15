---
"@langchain/langgraph-sdk": patch
---

Fix `getSubagentsByMessage` returning empty array for OpenAI models by updating `aiMessageId` when the provider replaces it during streaming.
