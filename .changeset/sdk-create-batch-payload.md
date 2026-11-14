---
"@langchain/langgraph-sdk": patch
---

fix(sdk): `runs.createBatch` sends each run in the schema's snake_case, so options like `interruptBefore`, `checkpointId`, `multitaskStrategy`, `afterSeconds` and `ifNotExists` are no longer silently dropped (and the stray `assistantId` key is gone).
