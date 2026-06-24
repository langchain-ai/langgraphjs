---
"@langchain/langgraph": patch
---

fix(langgraph): emit valid UUIDs for exit-mode delta task_ids

Exit-mode DeltaChannel writes used a step-prefixed synthetic task id that produced a 6-segment string Postgres rejects for `checkpoint_writes.task_id uuid` in LangGraph API. Embed the superstep in the first UUID group instead, matching langchain-ai/langgraph#8165.
