---
"@langchain/langgraph-api": patch
"@langchain/langgraph-cli": patch
"@langchain/langgraph-ui": patch
---

fix(cli): support node_version 24 in langgraph.json

Allow Node 24 in the CLI config schema and Docker base image resolution.
The langgraphjs-api:24 image is already published from langgraph-api.
