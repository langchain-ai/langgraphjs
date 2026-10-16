---
"@langchain/langgraph-api": patch
---

`run.start` input sent while a thread is paused on several interrupts now returns `invalid_argument` and leaves the thread paused, instead of starting a run that fails because one input can't say which interrupt it answers. Answer each interrupt with `input.respond`.
