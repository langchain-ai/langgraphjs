---
"@langchain/langgraph-api": minor
---

fix(langgraph-api): refuse a stale interrupt answer on the dev server

The dev server now runs graphs in strict resume mode: a `Command({ resume })` that names an interrupt that isn't pending, is an empty map, or is one value while several interrupts are pending ends the run with `UnknownInterruptError`, and the thread keeps its status, values and interrupts. A retried run, and an `interrupt` or `rollback` run that cancelled one in flight, resume as before.

Two things that used to succeed now fail: one value sent while several interrupts are pending, which answered all of them, and an answer sent twice, such as a double-click, whose second run was a silent no-op. Both now end the run with an error.
