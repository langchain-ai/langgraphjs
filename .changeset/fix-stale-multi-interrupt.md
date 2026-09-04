---
"@langchain/langgraph-sdk": patch
"@langchain/react": patch
---

fix(sdk): keep stream.interrupts truthful after sequential multi-interrupt resume

Locally-resolved interrupt ids are no longer permanently suppressed: live
`input.requested` events after the resume barrier can reappear, and a
post-resume reconcile against `threads.getState().tasks[].interrupts`
restores siblings the server still has pending. Prevents a stale-empty
`stream.interrupts` from driving a free-text `submit()` into an ambiguous
`Command(resume=…)` when multiple interrupts remain.
