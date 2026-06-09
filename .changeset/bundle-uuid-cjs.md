---
"@langchain/langgraph-checkpoint": patch
"@langchain/langgraph": patch
"@langchain/langgraph-sdk": patch
"@langchain/langgraph-supervisor": patch
"@langchain/langgraph-checkpoint-redis": patch
---

fix(build): bundle uuid into CJS outputs for Jest compatibility

uuid@12+ is ESM-only, but LangGraph ships dual ESM/CJS builds. CJS
artifacts previously called `require("uuid")`, which Jest cannot parse.
Bundle uuid into CJS outputs only (ESM keeps external uuid imports) so
Jest/CJS consumers get relative `.cjs` copies while tsx/ESM environment
tests keep working.

Fixes #2481
