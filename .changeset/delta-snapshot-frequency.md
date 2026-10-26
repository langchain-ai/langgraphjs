---
"@langchain/langgraph": patch
---

Change the default `DeltaChannel` snapshot frequency from 1000 to 100 updates, matching Python. Channels now persist full snapshots more frequently to reduce replay latency at the cost of increased storage. Set `snapshotFrequency: 1000` explicitly to retain the previous cadence.
