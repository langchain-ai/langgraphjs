---
"@langchain/langgraph-checkpoint": patch
"@langchain/langgraph": patch
"@langchain/langgraph-sdk": patch
"@langchain/langgraph-supervisor": patch
---

fix(build): bundle uuid into CJS outputs for Jest compatibility

uuid@12+ is ESM-only, but LangGraph ships dual ESM/CJS builds. CJS
artifacts previously called `require("uuid")`, which Jest cannot parse.
Configure the build to always bundle uuid so CJS consumers resolve
relative `.cjs` copies instead of uuid's ESM entry.

Fixes #2481
