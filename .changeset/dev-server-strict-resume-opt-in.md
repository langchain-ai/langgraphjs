---
"@langchain/langgraph-api": minor
---

feat(langgraph-api): refuse a stale interrupt answer only when the run asks for it with `strict_resume`

Strict resume, which 1.6.0 turned on for every run, is now opt-in. A run created with `strict_resume: true` (`strictResume` on the protocol's `run.start` and `input.respond`) runs the graph in strict resume mode: a `Command({ resume })` that names an interrupt that isn't pending, is an empty map, or is one value while several interrupts are pending ends the run with `UnknownInterruptError`, and the thread keeps its status, values and interrupts. The error event carries `reason`, `interrupt_ids` and `pending_ids`. A retried run, and an `interrupt` or `rollback` run that cancelled one in flight, resume as before. Runs that don't set it resume as they did before 1.6.0: one value answers every pending interrupt, and an answer sent twice is a no-op.
