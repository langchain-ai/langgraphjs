---
"@langchain/langgraph": patch
---

A drain requested right before an `interruptBefore` breakpoint now stops the run at the breakpoint. The run used to drain there instead, and resuming it with `invoke(null, config)` ran past the breakpoint, since a resume treats the next step's breakpoints as already passed.
