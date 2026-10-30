---
"@langchain/langgraph-api": patch
---

`run.start` input that isn't keyed by interrupt id is now refused with `invalid_argument` while the thread waits on an interrupt, and the thread stays paused. With one interrupt pending, the input used to become its answer, so a chat message could answer an approval; with several, it started a run that failed. Answer interrupts with `input.respond`, or with input keyed by interrupt id. Input sent while a run is in flight, or forking from a checkpoint, starts a new run instead of resuming. `input.respond` also works right after a server restart, without a `run.start` first.
