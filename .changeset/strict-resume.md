---
"@langchain/langgraph": minor
---

feat(langgraph): add a strict resume mode that refuses stale interrupt answers

With the private configurable key `__pregel_strict_resume` set, the root graph throws `UnknownInterruptError` before writing anything when a `Command({ resume })` names an interrupt that isn't pending, is an empty map, or is one value while several interrupts are pending. The error's `reason` (`not_pending`, `empty_map` or `ambiguous`) says which, with the interrupt ids involved in `interruptIds` and `pendingIds`. Without the key, resuming behaves as before.

A task that raises several interrupts at once, such as a subgraph with parallel interrupts, now keeps all of them; before, only the last one was saved. `Command({ resume: false })` and other falsy resume values now reach `interrupt()` instead of throwing `EmptyInputError`.
