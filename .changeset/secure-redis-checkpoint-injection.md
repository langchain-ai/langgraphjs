---
"@langchain/langgraph-checkpoint-redis": patch
---

fix(checkpoint-redis): block Redis KEYS / SCAN pattern injection via top-level identifiers

`RedisSaver` and `ShallowRedisSaver` previously embedded `thread_id`,
`checkpoint_ns`, `checkpoint_id`, and `task_id` directly into Redis keys
and `client.keys(pattern)` calls with no validation. A caller able to
shape any of those fields (multi-tenant SDK deployments where the
`RunnableConfig` originates from request input, or webhook payloads that
flow into a persisted thread) could promote a string identifier into a
glob pattern (`*`, `?`, `[...]`) or escape character (`\`).

The most severe sink is `deleteThread`: a `threadId` of `*` issues
`client.keys("checkpoint:*:*")` followed by `client.del(...)`, deleting
every checkpoint in the database across every tenant. `getTuple`,
`list`, and `loadPendingWrites` are exposed to the same pattern via
the fallback paths that bypass the existing `escapeRediSearchTagValue`
defense.

Adds a single `assertSafeKeyComponent` helper exported from
`./utils.js` and applies it at every key-building site. The guard
asserts the value is a non-empty string (the empty `checkpoint_ns`
default is opt-in via `{ allowEmpty: true }`) and rejects the Redis
pattern meta-characters `* ? [ ] \` plus the colon delimiter that
would otherwise corrupt the colon-delimited key structure. Behavior
for valid string identifiers is unchanged.
