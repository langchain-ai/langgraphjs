---
"@langchain/langgraph": patch
---

Close RemoteGraph's v3 thread stream when starting a run fails, and avoid creating a remote run when the caller's signal is already aborted.
