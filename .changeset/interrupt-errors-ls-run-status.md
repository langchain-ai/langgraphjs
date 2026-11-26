---
"@langchain/langgraph": patch
---

`GraphInterrupt` (and `NodeInterrupt`) and `ParentCommand` now carry `ls_run_status = "interrupted"`, so tracers report these runs as interrupted instead of errored.
