---
"@langchain/langgraph-api": patch
"@langchain/langgraph-cli": patch
---

fix(langgraph-api): support configurable TypeScript loaders in dev server

Add `node_loader` to `langgraph.json` (and `LANGGRAPH_NODE_LOADER` env override) so projects using reflect-metadata can use `ts-node` (`--loader ts-node/esm`) instead of the default tsx CLI. Other loaders default to `--import`; only registered shorthands like `ts-node` use `--loader`. `--no-reload` now also disables tsx's internal watch mode. Closes #1834.
