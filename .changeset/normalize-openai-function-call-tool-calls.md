---
"@langchain/langgraph-sdk": patch
---

fix(sdk): normalize OpenAI Responses function_call blocks into tool_calls

Promote provider-native `function_call` content blocks and
`response_metadata.output` entries to LangChain `tool_calls` during
message coercion so useStream consumers can rely on `message.tool_calls`.
