# @langchain/langgraph-checkpoint

## 1.1.3

### Patch Changes

- [#2566](https://github.com/langchain-ai/langgraphjs/pull/2566) [`091a46f`](https://github.com/langchain-ai/langgraphjs/commit/091a46f32ddd3a85ee89e35fb9ea953dfc4cf8b4) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(langgraph-checkpoint-postgres): prevent createAgent failures with PostgresSaver

  Add BaseCheckpointSaver.toJSON() so ConfigurableModel can stringify runnable config without traversing pg Pool timers, and default missing checkpoint maps on load/copy so resume no longer crashes on undefined versions_seen. Closes [#1808](https://github.com/langchain-ai/langgraphjs/issues/1808).

## 1.1.2

### Patch Changes

- [#2544](https://github.com/langchain-ai/langgraphjs/pull/2544) [`4487214`](https://github.com/langchain-ai/langgraphjs/commit/448721449f0801009ba76b03dd2e9c16f900bbba) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(langgraph): make concurrent DeltaChannel writes deterministic on replay

  Concurrent same-superstep writes to a `DeltaChannel` could reconstruct from a
  checkpoint differently than they were applied live, because live execution
  ordered them by task path while savers replayed them by task id. This fixes that
  divergence in two complementary ways:

  - Plain concurrent writes are now applied in the canonical `(task_id, idx)`
    order on both paths: `_applyWrites` orders them that way live, and the
    `getDeltaChannelHistory` walk enforces the same order so reconstruction
    matches live for every saver (Postgres, SQLite, MongoDB, Redis, and custom).
  - An `Overwrite` now wins its entire super-step: every sibling write in the same
    step — before AND after the `Overwrite` — is discarded, matching
    `BinaryOperatorAggregate`. This makes the result independent of the (unstable)
    ordering of concurrent fan-in writes; previously a plain write that landed
    after an `Overwrite` in the same step was still folded in.

  To keep reconstruction in sync with this `Overwrite` rule, any `DeltaChannel`
  that sees an `Overwrite` in a super-step is now force-snapshotted at the next
  checkpoint (and, under `"exit"` durability, in the final checkpoint). The
  post-overwrite value is materialized into `channel_values`, so a cold read seeds
  from that snapshot and never has to replay across the reset — making live and
  reconstructed state identical without changing the sparse-replay history shape.
  These delta-channel APIs remain Beta.

- [#2531](https://github.com/langchain-ai/langgraphjs/pull/2531) [`38cfe01`](https://github.com/langchain-ai/langgraphjs/commit/38cfe01ff02490ff6bcc86c66708ef671f2e0d4b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(langgraph): forward task metadata and name subagents via lc_agent_name

  `mapDebugTasks` now forwards filtered user-meaningful task config metadata
  (including `lc_agent_name`) onto `tasks` stream payloads. The lifecycle
  transformer uses that metadata to set subagent `graph_name` from
  `lc_agent_name` and recover `cause: { type: "toolCall", tool_call_id }`
  from parent tool-dispatch tasks. Adds the shared `EXCLUDED_METADATA_KEYS`
  constant to `@langchain/langgraph-checkpoint`. Ports langgraph#7928.

## 1.1.1

### Patch Changes

- [#2527](https://github.com/langchain-ai/langgraphjs/pull/2527) [`9e114e5`](https://github.com/langchain-ai/langgraphjs/commit/9e114e55d362a874878a817740de42fd62ae9db7) Thanks [@christian-bromann](https://github.com/christian-bromann)! - chore(deps): remove uuid dependency in favor of embedded uuid in core

  Replace direct `uuid` package imports with `@langchain/core/utils/uuid` across
  langgraph packages to deduplicate dependencies and align with @langchain/core's
  embedded UUID utilities.

## 1.1.0

### Minor Changes

- [#2452](https://github.com/langchain-ai/langgraphjs/pull/2452) [`a8e7659`](https://github.com/langchain-ai/langgraphjs/commit/a8e7659a9d22fd84425aaf26bda88667c76b185a) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Add `DeltaChannel` and the writes-history saver API (beta).

  `DeltaChannel` is a reducer channel that stores only a sentinel in checkpoint
  blobs instead of the full accumulated value, reconstructing state on read by
  replaying ancestor writes through a batch reducer. This avoids re-serializing
  the entire accumulated value at every step (e.g. long message histories).

  - `DeltaChannel(reducer, { snapshotFrequency })` in `@langchain/langgraph` —
    count-based snapshot cadence (default `snapshotFrequency=1000`) plus a
    system bound `DELTA_MAX_SUPERSTEPS_SINCE_SNAPSHOT` (default 5000, env
    `LANGGRAPH_DELTA_MAX_SUPERSTEPS_SINCE_SNAPSHOT`).
  - `messagesDeltaReducer` — a batching-invariant messages reducer that coerces
    raw object/string writes, for use with `DeltaChannel`.
  - `BaseCheckpointSaver.getDeltaChannelHistory({ config, channels })` (beta) —
    walks the parent chain returning per-channel `{ writes, seed? }`, with a
    direct-storage override in `MemorySaver`.
  - `counters_since_delta_snapshot` added to `CheckpointMetadata`; `DeltaSnapshot`
    serialization support in the JSON+ serializer.

  Reconstruction is wired through the Pregel read/execution paths (initialization,
  `getState`, `updateState`, local reads) and `exit` durability accumulates and
  anchors delta writes so threads remain reconstructible without forcing
  snapshots.

### Patch Changes

- [#2450](https://github.com/langchain-ai/langgraphjs/pull/2450) [`2f6d873`](https://github.com/langchain-ai/langgraphjs/commit/2f6d87368e590ae2fc2a7990fd13cb0a5fe3c198) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Add node-level timeouts.

  A `timeout` option is now supported on `StateGraph.addNode`, the functional API
  (`task`/`entrypoint`), and the `Send` constructor. Pass a number of milliseconds
  for a hard wall-clock cap, or a `TimeoutPolicy` for finer control:

  ```ts
  import { TimeoutPolicy } from "@langchain/langgraph";

  // hard wall-clock cap on each attempt
  builder.addNode("agent", agentFn, { timeout: 60_000 });

  // full control
  builder.addNode("agent", agentFn, {
    timeout: {
      runTimeout: 60_000, // hard wall-clock cap, never refreshed
      idleTimeout: 10_000, // cap on time without observable progress
      refreshOn: "auto", // "auto" | "heartbeat"
    },
  });

  // per-task override
  new Send("agent", state, { timeout: { idleTimeout: 5_000 } });
  ```

  When a timeout fires, a `NodeTimeoutError` (carrying `node`, `kind`
  (`"run"`/`"idle"`), `timeout`, `elapsed`, `runTimeout`, `idleTimeout`) is raised,
  the attempt's buffered writes are dropped, and the node's `AbortSignal` is
  aborted. `idleTimeout` is refreshed by observable progress (writes, custom
  stream-writer calls, child-task scheduling, callback events) or an explicit
  `runtime.heartbeat()` call. The timer resets per retry attempt, and
  `NodeTimeoutError` is retryable under the default retry policy.

  Ports langchain-ai/langgraph#7599, [#7646](https://github.com/langchain-ai/langgraphjs/issues/7646), and [#7659](https://github.com/langchain-ai/langgraphjs/issues/7659).

## 1.0.4

### Patch Changes

- [#2344](https://github.com/langchain-ai/langgraphjs/pull/2344) [`0125920`](https://github.com/langchain-ai/langgraphjs/commit/0125920a2c4a87dc1d66aaf541ea16146f8cf842) Thanks [@dependabot](https://github.com/apps/dependabot)! - chore(deps): bump uuid to 14.0.0 and keep checkpoint ID ordering stable

  Bump `uuid` from 10.x/13.x to 14.0.0 across packages. Starting with uuid 11, `v6({ clockseq })` no longer advances the sub-millisecond time counter when an explicit `clockseq` is passed, so checkpoint IDs created within the same millisecond were ordered only by `clockseq`. Since checkpoint IDs are sorted lexicographically, this broke ordering — most visibly for the negative `clockseq` used by the first ("input") checkpoint, which sorted as the newest.

  `uuid6()` now maintains its own monotonic `(msecs, nsecs)` clock (mirroring uuid 10's internal v1 behavior) so the time component is always strictly increasing and checkpoint ordering no longer depends on the `clockseq` value. `emptyCheckpoint()` also uses a non-negative `clockseq`.

## 1.0.3

### Patch Changes

- [#2352](https://github.com/langchain-ai/langgraphjs/pull/2352) [`14f2a79`](https://github.com/langchain-ai/langgraphjs/commit/14f2a796912e81d7f52f0a4f16747f6d0a269209) Thanks [@Nagendhra-web](https://github.com/Nagendhra-web)! - fix(langgraph-checkpoint): block prototype pollution in MemorySaver via reserved storage keys

  `MemorySaver` previously embedded `thread_id`, `checkpoint_ns`,
  `checkpoint_id`, and `task_id` directly into property accesses on the
  nested plain objects `this.storage` and `this.writes`. A caller able to
  shape any of those fields (every quickstart, tutorial, and test fixture
  uses `MemorySaver` by default) could pass `"__proto__"`,
  `"constructor"`, or `"prototype"` and have the subsequent assignment
  mutate `Object.prototype`. From that point every plain object in the
  process inherits the injected property, breaking `for...in` loops,
  truthy short-circuits, and downstream serializers across unrelated code
  paths. CWE-1321.

  Adds an `assertSafeStorageKey` chokepoint applied at every public entry
  that touches `storage` or `writes` (`put`, `putWrites`, `deleteThread`,
  `getTuple`, `list`). The guard rejects non-string values, the empty
  string (unless explicitly opted-in for `checkpoint_ns`), and the three
  prototype-pollution keys. Behaviour for valid string identifiers is
  unchanged.

## 1.0.2

### Patch Changes

- [#2314](https://github.com/langchain-ai/langgraphjs/pull/2314) [`085a07f`](https://github.com/langchain-ai/langgraphjs/commit/085a07f569b6d7d79728eb7eb6eb3a0c67fcdefb) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Improve `MemorySaver` diagnostics when checkpoint writes are missing a
  `thread_id`.

  The in-memory checkpointer now explains why `configurable.thread_id` is
  required and includes a concrete `graph.stream(..., { configurable: {
thread_id } })` example in the error message. This makes the new
  thread-oriented event streaming flows easier to debug when an application
  forgets to provide durable thread configuration.

## 1.0.1

### Patch Changes

- [#2190](https://github.com/langchain-ai/langgraphjs/pull/2190) [`b6cfe55`](https://github.com/langchain-ai/langgraphjs/commit/b6cfe555bfb498fe24fa85847f0fe5d1194dfa39) Thanks [@colifran](https://github.com/colifran)! - feat(langgraph): implement uint8array support for json plus serializer

## 1.0.0

### Major Changes

- 1e1ecbb: This release updates the package for compatibility with LangGraph v1.0. See the [v1.0 release notes](https://docs.langchain.com/oss/javascript/releases/langgraph-v1) for details on what's new.

## 0.1.1

### Patch Changes

- 11c7807: Add support for @langchain/core 1.0.0-alpha

## 0.1.0

### Minor Changes

- 10f292a: Remove pending_sends from parent checkpoints in favour of TASKS channel
- 3fd7f73: Allow asynchronous serialization and deserialization
- 773ec0d: Remove Checkpoint.writes

### Patch Changes

- ccbcbc1: Add delete thread method to checkpointers
