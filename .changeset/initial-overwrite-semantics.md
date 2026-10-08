---
"@langchain/langgraph": patch
---

Fix Overwrite handling for reducer channels without an initial value. An overwrite in the first update batch now suppresses subsequent normal writes and rejects a second overwrite in the same step, matching initialized channels.
