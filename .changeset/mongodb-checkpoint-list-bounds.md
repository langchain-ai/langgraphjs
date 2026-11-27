---
"@langchain/langgraph-checkpoint-mongodb": patch
"@langchain/langgraph-checkpoint-validation": patch
---

Honor `checkpoint_id` and zero result limits when listing MongoDB checkpoints. An exact checkpoint selection is now combined with `before` and metadata filters, and `limit: 0` returns an empty page instead of the full history. Add shared validation for zero result limits.
