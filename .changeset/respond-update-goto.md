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
