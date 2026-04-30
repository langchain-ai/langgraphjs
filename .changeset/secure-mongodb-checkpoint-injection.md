---
"@langchain/langgraph-checkpoint-mongodb": patch
---

fix(checkpoint-mongodb): block NoSQL operator injection via top-level identifiers

`MongoDBSaver.{getTuple,list,put,putWrites,deleteThread}` previously embedded
`thread_id`, `checkpoint_ns`, `checkpoint_id`, and `task_id` directly into
MongoDB queries with no type validation. A caller that can shape those
fields, for example a multi-tenant SDK deployment where the
`RunnableConfig` originates from request input, or a webhook body that
flows into a persisted thread, could pass an object such as `{ $ne: null }`
and have MongoDB return or overwrite checkpoints belonging to other
tenants (CWE-943).

This patch adds a single static `assertSafeIdentifier` guard that mirrors
the existing primitive-only enforcement applied to `metadata.*` filter
keys, and applies it at every query-building site. Behaviour for valid
string identifiers is unchanged. Invalid types now raise a precise error
with the field name, observed type, and a pointer to the security
rationale.
