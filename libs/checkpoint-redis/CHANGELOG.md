# @langchain/langgraph-checkpoint-redis

## 1.0.7

### Patch Changes

- [#2344](https://github.com/langchain-ai/langgraphjs/pull/2344) [`0125920`](https://github.com/langchain-ai/langgraphjs/commit/0125920a2c4a87dc1d66aaf541ea16146f8cf842) Thanks [@dependabot](https://github.com/apps/dependabot)! - chore(deps): bump uuid to 14.0.0 and keep checkpoint ID ordering stable

  Bump `uuid` from 10.x/13.x to 14.0.0 across packages. Starting with uuid 11, `v6({ clockseq })` no longer advances the sub-millisecond time counter when an explicit `clockseq` is passed, so checkpoint IDs created within the same millisecond were ordered only by `clockseq`. Since checkpoint IDs are sorted lexicographically, this broke ordering — most visibly for the negative `clockseq` used by the first ("input") checkpoint, which sorted as the newest.

  `uuid6()` now maintains its own monotonic `(msecs, nsecs)` clock (mirroring uuid 10's internal v1 behavior) so the time component is always strictly increasing and checkpoint ordering no longer depends on the `clockseq` value. `emptyCheckpoint()` also uses a non-negative `clockseq`.

## 1.0.6

### Patch Changes

- [#2350](https://github.com/langchain-ai/langgraphjs/pull/2350) [`1e73c6b`](https://github.com/langchain-ai/langgraphjs/commit/1e73c6b4630bbc4aa976eea4bfc33c4f753b7ee9) Thanks [@Nagendhra-web](https://github.com/Nagendhra-web)! - fix(checkpoint-redis): block Redis KEYS / SCAN pattern injection via top-level identifiers

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
  pattern meta-characters `* ? [ ] \`. The `:` delimiter is intentionally
  permitted because LangGraph emits it as a legitimate part of
  `checkpoint_ns` for subgraphs / nested graphs, where it only ever
  appears as a literal in the key. Behavior for valid string identifiers
  is unchanged.

## 1.0.5

### Patch Changes

- [#2208](https://github.com/langchain-ai/langgraphjs/pull/2208) [`ebeb145`](https://github.com/langchain-ai/langgraphjs/commit/ebeb1452d27fcca100cd63bdfd4a7f020949412c) Thanks [@jackjin1997](https://github.com/jackjin1997)! - Fix `deleteThread()` using wrong key pattern (`writes:` instead of `checkpoint_write:`) and add missing cleanup of `write_keys_zset:` entries.

## 1.0.4

### Patch Changes

- [#2181](https://github.com/langchain-ai/langgraphjs/pull/2181) [`a8f1b9d`](https://github.com/langchain-ai/langgraphjs/commit/a8f1b9d26bf25de2177ceb1e8d552ce036f5ade4) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(checkpoint-redis): fix dependency

## 1.0.3

### Patch Changes

- [#2026](https://github.com/langchain-ai/langgraphjs/pull/2026) [`c35c274`](https://github.com/langchain-ai/langgraphjs/commit/c35c274a5dffc702b355d4c32dbc3caed7c8b56a) Thanks [@pawel-twardziak](https://github.com/pawel-twardziak)! - fix(checkpoint-redis): detect existing writes in put to preserve has_writes flag

## 1.0.2

### Patch Changes

- [#1943](https://github.com/langchain-ai/langgraphjs/pull/1943) [`814c76d`](https://github.com/langchain-ai/langgraphjs/commit/814c76dc3938d0f6f7e17ca3bc11d6a12270b2a1) Thanks [@hntrl](https://github.com/hntrl)! - fix(redis): escape RediSearch filter values

  Added proper escaping for filter keys and values when constructing RediSearch queries
  in the `list()` method to handle special characters correctly.

## 1.0.1

### Patch Changes

- 9440d08: Fix LangChain objects not being deserialized properly from checkpointed state

## 1.0.0

### Major Changes

- 1e1ecbb: This release updates the package for compatibility with LangGraph v1.0. See the [v1.0 release notes](https://docs.langchain.com/oss/javascript/releases/langgraph-v1) for details on what's new.

### Patch Changes

- Updated dependencies [1e1ecbb]
  - @langchain/langgraph-checkpoint@1.0.0

## 0.0.2

### Patch Changes

- 926db1e: Allow using @langchain/core@^1.0.0-alpha
