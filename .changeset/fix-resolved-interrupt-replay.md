---
"@langchain/langgraph-sdk": patch
---

fix(sdk): don't re-show resolved interrupts after reload

After a reload, the next submit used to replay the old `input.requested`
event, so the HITL form came back even though the interrupt was already
answered. Keep filtering historical interrupts after the command is
accepted, using the response's `applied_through_seq` as the cutoff.
