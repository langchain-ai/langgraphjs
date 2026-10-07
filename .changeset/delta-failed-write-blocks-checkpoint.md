---
"@langchain/langgraph": patch
---

fix(langgraph): a checkpoint save now waits for the DeltaChannel writes it reads and is skipped if one of them failed, so a failed write no longer leaves the channel reading back without it.
