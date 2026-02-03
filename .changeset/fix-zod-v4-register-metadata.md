---
"@langchain/langgraph": patch
---

fix: preserve `langgraph_type` metadata for LangSmith Studio tab detection

- **Zod v4 `.register()` fix**: The metadata registry now properly stores and retrieves `langgraph_type` metadata when using Zod v4's `.register()` method with `MessagesZodMeta`
- **StateSchema fix**: `StateSchema.getJsonSchema()` now correctly includes `jsonSchemaExtra` (like `langgraph_type: "messages"`) even when the underlying schema (e.g., `z.custom()`) doesn't produce a JSON schema
