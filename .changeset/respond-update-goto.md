---
"@langchain/langgraph-sdk": patch
"@langchain/react": patch
"@langchain/vue": patch
"@langchain/svelte": patch
"@langchain/angular": patch
"@langchain/langgraph-api": patch
"@langchain/langgraph": patch
---

fix(sdk): apply state update and goto alongside interrupt resume

`respond(decision, { update, goto })` now maps to LangGraph's
`Command(resume, update, goto)`, so a human-in-the-loop UI can commit a state
update (e.g. push the interrupt card into state) in the **same superstep** as
the resume — one checkpoint, no separate `updateState` write, no flicker.
`@langchain/langgraph-api` forwards `update`/`goto` through `input.respond`,
and `@langchain/core` message instances in `update` are serialized to dicts
before transport, exactly like `submit()`. Bumps `@langchain/protocol` to
`^0.0.18` for the `Goto` type.

`respond`/`respondAll` also apply `update` **optimistically** (mirroring
`submit()`): the pushed messages paint immediately, with stable ids minted so
the resumed run's echo reconciles them in place. Without this the interrupt is
cleared the instant `respond()` dispatches while the pushed card only reappears
a server round-trip later — so the card would flicker in that gap. The
optimistic state settles on the resumed run's terminal (pending → sent, or
rolled back on a failure before any echo).

User-initiated optimistic writes (`submit()` / `respond()` / `respondAll()`) now
commit to the store **synchronously**, in the same tick as the triggering event,
instead of being coalesced onto the next macrotask. This lets a framework render
the pushed message in the **same commit** as any local UI state the caller flips
alongside it (e.g. a HITL form swapping its inputs for the resolved card), so the
card no longer blinks out for the one-macrotask window before the flush lands.
High-frequency streaming writes keep their macrotask coalescing.
