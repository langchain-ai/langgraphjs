---
"@langchain/langgraph": patch
---

exit durability no longer saves a checkpoint as its own parent when a run ends without running anything, such as replaying the newest checkpoint of a finished thread; with a DeltaChannel, reading such a thread crashed
