---
"@langchain/langgraph": patch
---

`createReactAgent` no longer ends the run when a `returnDirect` tool fails. A `ToolMessage` with `status: "error"` now goes back to the model so it can correct the call and retry; the run still ends on the first successful `returnDirect` result.
