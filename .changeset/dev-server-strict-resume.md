---
"@langchain/langgraph-api": patch
---

fix(langgraph-api): refuse a stale interrupt answer on the dev server

The dev server now runs graphs in strict resume mode: a `Command({ resume })` that names an interrupt that isn't pending, is an empty map, or is one value while several interrupts are pending ends the run with `UnknownInterruptError`, and the thread keeps its status, values and interrupts. A retried run, and a run started with the `interrupt` or `rollback` multitask strategy, resume as before.
