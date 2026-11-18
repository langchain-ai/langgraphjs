---
"@langchain/langgraph": patch
---

Allow Functional API tasks to finish before an `interruptAfter` breakpoint on their entrypoint. Previously the first task call could interrupt its still-running caller, leaving no tasks to resume.
