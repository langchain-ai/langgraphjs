---
"@langchain/langgraph": patch
---

Resuming after some parallel interrupts were answered no longer reruns the nodes and `task()` calls that already finished, in a subgraph or when the resume is sent with the id of the thread's latest checkpoint. Finished tasks now rerun only on time travel, or on a resume at a checkpoint the thread has moved past.
