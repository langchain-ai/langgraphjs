# @langchain/langgraph-checkpoint-redis

## 1.0.10

### Patch Changes

- [#2336](https://github.com/langchain-ai/langgraphjs/pull/2336) [`25907eb`](https://github.com/langchain-ai/langgraphjs/commit/25907eb0be25258c26327c6c68c72bc828ee1cff) Thanks [@MohMaherId](https://github.com/MohMaherId)! - fix(langgraph-checkpoint-redis): persist and reconstruct full `channel_values` across multi-node graphs.

  `RedisSaver.put()` delta-filters `channel_values` to only the channels written by the current node, but `getTuple()` had no reconstruction logic — unlike `PostgresSaver` — so any multi-node graph whose last node wrote a subset of channels silently lost the others. Each changed channel is now persisted as a version-keyed `checkpoint_blob:*` entry in `put()` and missing channels are reconstructed from those blobs on read.

  `deleteThread()` now also deletes the `checkpoint_blob:*` keys. Without this the blobs introduced above would orphan forever (memory growth) and thread deletion would be incomplete, matching `PostgresSaver.deleteThread()` parity.

  When `ttlConfig.refreshOnRead` is enabled, reads now refresh the TTL of the reconstructed `checkpoint_blob:*` keys alongside the checkpoint key. Otherwise a read would keep the checkpoint alive while the blobs it depends on expired, silently dropping reconstructed channels.

  On write, `put()` now refreshes the TTL of every blob the checkpoint references (the full `channel_versions` set), not just the channels changed by the current node, so carried-over blobs from earlier nodes expire in lockstep with the checkpoint doc. This write-side refresh is independent of `refreshOnRead`. The per-channel blob writes also now run in parallel.

  Known limitation: with TTL enabled, a carried-over blob can still be lost if it expires during an idle gap longer than `defaultTTL` (no read or write refreshed it in time). When that happens the channel is left cleanly absent on read rather than erroring. Fully closing this gap (re-persisting expired blobs) is tracked as a follow-up.

## 1.0.9

### Patch Changes

- [#2525](https://github.com/langchain-ai/langgraphjs/pull/2525) [`829a32a`](https://github.com/langchain-ai/langgraphjs/commit/829a32a30cc22103b1cb0aba6a027b7ccdb68447) Thanks [@lhlyu](https://github.com/lhlyu)! - Fix Redis checkpoint pending write deserialization when a write document has no `value` field. RedisJSON omits `undefined` values, so `loadPendingWrites` now restores a missing `value` as `undefined` instead of passing it through JSON parsing.

- [#2527](https://github.com/langchain-ai/langgraphjs/pull/2527) [`9e114e5`](https://github.com/langchain-ai/langgraphjs/commit/9e114e55d362a874878a817740de42fd62ae9db7) Thanks [@christian-bromann](https://github.com/christian-bromann)! - chore(deps): remove uuid dependency in favor of embedded uuid in core

  Replace direct `uuid` package imports with `@langchain/core/utils/uuid` across
  langgraph packages to deduplicate dependencies and align with @langchain/core's
  embedded UUID utilities.

## 1.0.8

### Patch Changes

- [#2518](https://github.com/langchain-ai/langgraphjs/pull/2518) [`9182ea3`](https://github.com/langchain-ai/langgraphjs/commit/9182ea35ecc1f932eb864fa7dc4fb32a00c5f7d6) Thanks [@jackjin1997](https://github.com/jackjin1997)! - fix: `RedisSaver.putWrites` now honors `WRITES_IDX_MAP`, pinning special channels (`__error__`, `__scheduled__`, `__interrupt__`, `__resume__`) to fixed negative indices in their Redis key (`checkpoint_write:…:<idx>`) instead of the call-local ordinal. Previously a mixed `putWrites([[…regular…], [INTERRUPT, …]], taskId)` placed the INTERRUPT key at the positive idx of its position in the batch, where a peer task's regular write at the same idx would overwrite it via the unconditional `JSON.SET`. The conflict-resolution clause now matches Postgres / SQLite / MongoDB: unguarded `JSON.SET` when every write is a special channel, `JSON.SET … NX` (insert-or-ignore) otherwise.

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
