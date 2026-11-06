---
"@langchain/langgraph-api": patch
---

fix(langgraph-api): the protocol's `run.start` reads the multitask strategy from `multitask_strategy`, falling back to `multitaskStrategy`, on the dev server and the embed server.
