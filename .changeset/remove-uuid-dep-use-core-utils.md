---
"@langchain/langgraph-checkpoint": patch
"@langchain/langgraph-checkpoint-redis": patch
"@langchain/langgraph-api": patch
"@langchain/langgraph-cli": patch
"@langchain/langgraph-ui": patch
"@langchain/langgraph": patch
"@langchain/langgraph-supervisor": patch
"@langchain/langgraph-sdk": patch
---

chore(deps): remove uuid dependency in favor of embedded uuid in core

Replace direct `uuid` package imports with `@langchain/core/utils/uuid` across
langgraph packages to deduplicate dependencies and align with @langchain/core's
embedded UUID utilities.
