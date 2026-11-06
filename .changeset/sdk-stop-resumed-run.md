---
"@langchain/langgraph-sdk": patch
---

fix(sdk): `stop()` cancels the run `respond()` or `respondAll()` started, also when it is called before that run starts, and shows again the interrupts the cancel left waiting.
