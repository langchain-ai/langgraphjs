---
"@langchain/langgraph": patch
---

give each update of a multi-update `bulkUpdateState` super-step its own task id, so a DeltaChannel keeps every update instead of only the first
