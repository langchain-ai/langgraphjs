---
"@langchain/langgraph-api": patch
---

A `run.start` that forks from a checkpoint (`forkFrom` in the SDK) now starts a new run from that checkpoint even while the thread waits on an interrupt. The dev server and the embed server took the fork's input as the answer to that interrupt, or refused it when several were pending, so editing a message while a run was paused dropped the edit.
