---
"@langchain/langgraph-api": patch
"@langchain/langgraph-cli": patch
"@langchain/langgraph-ui": patch
---

fix(api): inject langgraph_auth_user on protocol-v2 run.start

Stamp authenticated user fields onto run config in createOrResumeRun so
v2 streaming matches the REST runs API. Shared helpers also dedupe REST
run config auth/header enrichment.
