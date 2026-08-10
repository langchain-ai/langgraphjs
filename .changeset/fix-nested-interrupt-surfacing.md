---
"@langchain/langgraph-sdk": patch
---

fix(sdk): surface nested interrupts on stream.interrupts

`input.requested` events from subgraphs/subagents were dropped live by a root-only filter, while hydrate seeded them from `state.tasks`, so HITL UIs saw nested interrupts only after reload. Mirror every namespace onto `rootStore.interrupts` (with `Interrupt.namespace`), and resolve that namespace in `respond({ interruptId })` when callers omit it.
