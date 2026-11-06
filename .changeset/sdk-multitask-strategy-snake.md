---
"@langchain/langgraph-sdk": patch
---

fix(sdk): `run.start` sends the multitask strategy as `multitask_strategy`, like the protocol's other fields, as well as `multitaskStrategy`, which older servers read.
