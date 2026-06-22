---
"@langchain/langgraph-api": patch
"@langchain/langgraph-cli": patch
---

fix(langgraph-api): support configurable TypeScript loaders in dev server

Add `node_loader` to `langgraph.json` (and `LANGGRAPH_NODE_LOADER` env override) so projects using reflect-metadata can use `ts-node/esm` or other Node `--import` loaders instead of the default tsx CLI. Closes #1834.
