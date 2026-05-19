---
"@langchain/langgraph-sdk": patch
---

Move `@langchain/core` from a runtime dependency back to a required peer dependency so installing the SDK alone no longer pulls in `@langchain/core` (and `js-tiktoken`, etc.). Consumers that use streaming or message coercion must install `@langchain/core` explicitly or via `@langchain/langgraph`.
