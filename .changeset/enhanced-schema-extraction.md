---
"@langchain/langgraph-api": minor
---

feat(langgraph-api): enhance runtime JSON schema extraction with multi-tier strategy

Added a robust multi-tier extraction system for `getRuntimeGraphSchema()`:
- Priority 1: StateSchema instances with native `getJsonSchema()` support
- Priority 2: Zod schemas via schemaMetaRegistry (preserves jsonSchemaExtra from withLangGraph)
- Priority 3: Direct Zod v3/v4 conversion fallback
- Priority 4: Falls through to static TypeScript parser
