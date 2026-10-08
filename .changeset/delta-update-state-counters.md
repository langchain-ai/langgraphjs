---
"@langchain/langgraph": patch
---

fix(langgraph): `updateState` saves `counters_since_delta_snapshot` on every checkpoint it creates, so the next run keeps counting from it instead of from zero and DeltaChannels snapshot on schedule after an update.
