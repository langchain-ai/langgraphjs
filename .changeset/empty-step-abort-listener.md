---
"@langchain/langgraph": patch
---

A step with no task to run, such as one whose tasks were all served from the node cache, no longer leaves an abort listener on the run's signal. Aborting the signal later, at a later step or after the run has returned, no longer produces an unhandled `Error: Abort` rejection.
