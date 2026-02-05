---
"@langchain/langgraph-api": patch
---

Enhanced JSON schema extraction for Studio with multi-tier strategy:

- **StateSchema support**: Extract schemas from `StateSchema` instances using `getJsonSchema()` and `getInputJsonSchema()` methods, preserving `jsonSchemaExtra` metadata (e.g., `langgraph_type: "messages"`)
- **Improved Zod handling**: Fall back to Zod registry extraction for `withLangGraph()` schemas, then direct Zod conversion for plain Zod schemas
- **Reduced reliance on TypeScript parser**: Only fall back to the brittle TypeScript AST parser when all runtime extraction methods fail

Extraction priority:
1. StateSchema (handles `jsonSchemaExtra` via `ReducedValue`)
2. Zod via `schemaMetaRegistry` (handles `jsonSchemaExtra` from `withLangGraph()`)
3. Direct Zod conversion (no `jsonSchemaExtra`, but better than static parsing)
4. Static TypeScript parser (fallback)
