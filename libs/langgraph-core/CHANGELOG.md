# @langchain/langgraph

## 1.4.7

### Patch Changes

- [#2571](https://github.com/langchain-ai/langgraphjs/pull/2571) [`85ba859`](https://github.com/langchain-ai/langgraphjs/commit/85ba859b6f60f4bf193d3313fa24149efe05491b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(langgraph): drop unused zod-to-json-schema peer dependency

  Remove the vestigial `zod-to-json-schema` (and its `peerDependenciesMeta`/dev) declarations. JSON Schema generation now flows through `@langchain/core`'s Zod v3/v4 interop (`toJsonSchema`), so the old `zod-to-json-schema@^3.x` peer (which pins `zod@^3.24.1`) is no longer needed and was the last source of install-time peer conflicts with Zod v4. Closes [#1706](https://github.com/langchain-ai/langgraphjs/issues/1706).

## 1.4.6

### Patch Changes

- [`03a0d8b`](https://github.com/langchain-ai/langgraphjs/commit/03a0d8b8632082e6dbf4a96fcf37f8f67151b74f) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(langgraph): emit valid UUIDs for exit-mode delta task_ids

  Exit-mode DeltaChannel writes used a step-prefixed synthetic task id that produced a 6-segment string Postgres rejects for `checkpoint_writes.task_id uuid` in LangGraph API. Embed the superstep in the first UUID group instead, matching langchain-ai/langgraph#8165.

- Updated dependencies [[`0558e47`](https://github.com/langchain-ai/langgraphjs/commit/0558e472b7697304c62cb6fe69cc3005e8e1a457), [`091a46f`](https://github.com/langchain-ai/langgraphjs/commit/091a46f32ddd3a85ee89e35fb9ea953dfc4cf8b4)]:
  - @langchain/langgraph-sdk@1.9.25
  - @langchain/langgraph-checkpoint@1.1.3

## 1.4.5

### Patch Changes

- [#2557](https://github.com/langchain-ai/langgraphjs/pull/2557) [`b1e856d`](https://github.com/langchain-ai/langgraphjs/commit/b1e856d987ac16148dc0872d1fecf70e659ef28e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): apply state update and goto alongside interrupt resume

  `respond(decision, { update, goto })` now maps to LangGraph's
  `Command(resume, update, goto)`, so a human-in-the-loop UI can commit a state
  update (e.g. push the interrupt card into state) in the **same superstep** as
  the resume — one checkpoint, no separate `updateState` write, no flicker.
  `@langchain/langgraph-api` forwards `update`/`goto` through `input.respond`,
  and `@langchain/core` message instances in `update` are serialized to dicts
  before transport, exactly like `submit()`. Bumps `@langchain/protocol` to
  `^0.0.18` for the `Goto` type.

  `respond`/`respondAll` also apply `update` **optimistically** (mirroring
  `submit()`): the pushed messages paint immediately, with stable ids minted so
  the resumed run's echo reconciles them in place. Without this the interrupt is
  cleared the instant `respond()` dispatches while the pushed card only reappears
  a server round-trip later — so the card would flicker in that gap. The
  optimistic state settles on the resumed run's terminal (pending → sent, or
  rolled back on a failure before any echo).

  User-initiated optimistic writes (`submit()` / `respond()` / `respondAll()`) now
  commit to the store **synchronously**, in the same tick as the triggering event,
  instead of being coalesced onto the next macrotask. This lets a framework render
  the pushed message in the **same commit** as any local UI state the caller flips
  alongside it (e.g. a HITL form swapping its inputs for the resolved card), so the
  card no longer blinks out for the one-macrotask window before the flush lands.
  High-frequency streaming writes keep their macrotask coalescing.

- Updated dependencies [[`b1e856d`](https://github.com/langchain-ai/langgraphjs/commit/b1e856d987ac16148dc0872d1fecf70e659ef28e)]:
  - @langchain/langgraph-sdk@1.9.24

## 1.4.4

### Patch Changes

- [#2552](https://github.com/langchain-ai/langgraphjs/pull/2552) [`d662cbb`](https://github.com/langchain-ai/langgraphjs/commit/d662cbbc63eebdf1312e57d41908da1b9018e783) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(langgraph): isolate concurrent singleton-agent invocations by thread

  `ensureLangGraphConfig` ignores the ambient `AsyncLocalStorage` `configurable`
  on root-level invokes that supply an invoke-time `thread_id` and have no nesting
  keys (ignoring graph-bound `.withConfig()` defaults). On a fresh top-level run
  the ambient `configurable` can belong to another concurrent invocation, so its
  keys — internal scratchpad/task-input as well as user keys like
  `tenant_id`/`user_id` — must not leak in; values the caller wants arrive through
  the explicit (bound + invoke-time) configs. Ambient nesting (`__pregel_read__`)
  and bound child graphs invoked from parent tasks are unaffected. This prevents
  cross-invocation leakage between concurrent `invoke()` calls on a shared compiled
  graph (e.g. BullMQ workers with `concurrency > 1`). Complements the config-merge
  fix that stopped shared graph-bound `metadata`/`configurable` objects from being
  mutated across invocations
  ([#2040](https://github.com/langchain-ai/langgraphjs/issues/2040)).

- [#2553](https://github.com/langchain-ai/langgraphjs/pull/2553) [`1c2aa5b`](https://github.com/langchain-ai/langgraphjs/commit/1c2aa5bfeacd8b7463e3d5b6010daee26e9217e0) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(langgraph): recognize JSON-erased `Overwrite` values across runtimes

  `Overwrite` already survives JSON serialization in JS because `Overwrite.toJSON()`
  emits the canonical `{ "__overwrite__": value }` sentinel. `_getOverwriteValue`
  now additionally recognizes the discriminator form `{ "type": "__overwrite__",
value }` produced when a typed `Overwrite` from another runtime (e.g. a Python
  dataclass routed through the LangGraph API server) is serialized and its type is
  erased. This keeps `Overwrite` (and `DeltaChannel`) semantics intact across
  cross-runtime JSON boundaries. These delta-channel APIs remain Beta.

## 1.4.3

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

- [#2531](https://github.com/langchain-ai/langgraphjs/pull/2531) [`38cfe01`](https://github.com/langchain-ai/langgraphjs/commit/38cfe01ff02490ff6bcc86c66708ef671f2e0d4b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(langgraph): merge instead of overwrite in `ensureLangGraphConfig`

  `ensureLangGraphConfig` now per-key merges `callbacks`, `tags`, `metadata`,
  and `configurable` across configs instead of last-write-wins, so values
  bound via `.withConfig({...})` survive when a later (e.g. invoke-time)
  config supplies other keys. The merged dicts are fresh objects, fixing a
  by-reference mutation of shared base configs. Also drops the now-redundant
  `combineCallbacks` workaround in `streamEvents`, which double-registered and
  double-fired graph-bound callbacks.

- [#2531](https://github.com/langchain-ai/langgraphjs/pull/2531) [`38cfe01`](https://github.com/langchain-ai/langgraphjs/commit/38cfe01ff02490ff6bcc86c66708ef671f2e0d4b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(langgraph): preserve namespace nesting for imperative graph invokes

  When a compiled graph is invoked from inside another graph's running task
  (e.g. a tool body calling `subAgent.invoke(...)`), the surrounding task
  context — including the langgraph-internal nesting keys (`__pregel_read`,
  `__pregel_stream`, `checkpoint_ns`, the checkpoint map) — is propagated
  implicitly via `AsyncLocalStorage`. The base `Runnable.stream` calls
  langchain-core's `ensureConfig`, which replaces the ambient `configurable`
  wholesale whenever the caller passes its own. Because `createAgent` always
  supplies a `configurable`, every tool-invoked sub-agent lost those keys, ran
  as a fresh root run, and had its streamed events flattened to the root
  namespace instead of nesting under the triggering task.

  `Pregel.stream` now merges the ambient `configurable` underneath the caller's
  (caller keys win per-key) when the ambient marks an active task
  (`__pregel_read` present) but the explicit `configurable` is missing it.
  Declared subgraph nodes (which already carry their own `__pregel_read`) and
  top-level runs are unaffected.

- [#2537](https://github.com/langchain-ai/langgraphjs/pull/2537) [`be09666`](https://github.com/langchain-ai/langgraphjs/commit/be096663f42fe7ea9355d6c0def4854e657866d8) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(langgraph): dispatch stream messages handler inline

  The v3 `messages` handler (`StreamProtocolMessagesHandler`, which powers
  `run.messages`) only performs a synchronous `push()` onto the run's stream, but
  its callbacks were dispatched on LangChain's background callback queue (the
  default `awaitHandlers === false`). A model or tool call inside a nested or
  parallel task could therefore flush its `messages` chunk _after_ the Pregel
  loop returned and sealed the stream, where `IterableReadableWritableStream.push`
  silently drops chunks once closed. This surfaced as empty per-message streams
  (`sub.messages`) for subagents dispatched in parallel from a single tools step.

  The handler now sets `awaitHandlers = true` so its callbacks run inline — every
  push happens during the originating model/chain call while the stream is still
  open. This avoids the global over-wait, fake-timer deadlock, and error-path
  unhandled rejections that a blanket `awaitAllCallbacks()` drain before close
  would have introduced.

- [#2531](https://github.com/langchain-ai/langgraphjs/pull/2531) [`38cfe01`](https://github.com/langchain-ai/langgraphjs/commit/38cfe01ff02490ff6bcc86c66708ef671f2e0d4b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(langgraph): forward task metadata and name subagents via lc_agent_name

  `mapDebugTasks` now forwards filtered user-meaningful task config metadata
  (including `lc_agent_name`) onto `tasks` stream payloads. The lifecycle
  transformer uses that metadata to set subagent `graph_name` from
  `lc_agent_name` and recover `cause: { type: "toolCall", tool_call_id }`
  from parent tool-dispatch tasks. Adds the shared `EXCLUDED_METADATA_KEYS`
  constant to `@langchain/langgraph-checkpoint`. Ports langgraph#7928.

- [#2549](https://github.com/langchain-ai/langgraphjs/pull/2549) [`bc667a9`](https://github.com/langchain-ai/langgraphjs/commit/bc667a998ae9909d15795387dad45048e8947219) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(langgraph): support DeltaChannel fields in StateSchema

  Add a `DeltaValue` state field (and a `MessagesDeltaValue` prebuilt) so a
  `DeltaChannel` can be declared via `StateSchema`, not just `Annotation.Root` or
  a raw channel map. `StateSchema` now maps `DeltaValue` to a `DeltaChannel`
  (forwarding `snapshotFrequency` and the value-schema default) and validates its
  inputs/`Overwrite` updates like `ReducedValue`.

- Updated dependencies [[`4487214`](https://github.com/langchain-ai/langgraphjs/commit/448721449f0801009ba76b03dd2e9c16f900bbba), [`2134c8a`](https://github.com/langchain-ai/langgraphjs/commit/2134c8a2c0bc8dd2ebea33e1191c8dd0c4b83236), [`38cfe01`](https://github.com/langchain-ai/langgraphjs/commit/38cfe01ff02490ff6bcc86c66708ef671f2e0d4b)]:
  - @langchain/langgraph-checkpoint@1.1.2
  - @langchain/langgraph-sdk@1.9.23

## 1.4.2

### Patch Changes

- [#2527](https://github.com/langchain-ai/langgraphjs/pull/2527) [`9e114e5`](https://github.com/langchain-ai/langgraphjs/commit/9e114e55d362a874878a817740de42fd62ae9db7) Thanks [@christian-bromann](https://github.com/christian-bromann)! - chore(deps): remove uuid dependency in favor of embedded uuid in core

  Replace direct `uuid` package imports with `@langchain/core/utils/uuid` across
  langgraph packages to deduplicate dependencies and align with @langchain/core's
  embedded UUID utilities.

- Updated dependencies [[`ba31f04`](https://github.com/langchain-ai/langgraphjs/commit/ba31f045d1d458a456c6f6441e8ee81d32c5c700), [`e7e8035`](https://github.com/langchain-ai/langgraphjs/commit/e7e8035fadca5f0d4cbc55bbbb77e65878ab2952), [`9e114e5`](https://github.com/langchain-ai/langgraphjs/commit/9e114e55d362a874878a817740de42fd62ae9db7)]:
  - @langchain/langgraph-sdk@1.9.22
  - @langchain/langgraph-checkpoint@1.1.1

## 1.4.1

### Patch Changes

- [#2520](https://github.com/langchain-ai/langgraphjs/pull/2520) [`2da5c33`](https://github.com/langchain-ai/langgraphjs/commit/2da5c3374f7b91ba0afa607c507e2ff1591baca7) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(state): validate Zod state updates from nodes

  Validate node return values and Command updates against Zod state schema
  constraints before applying them to graph state.

  Fixes [#2519](https://github.com/langchain-ai/langgraphjs/issues/2519)

- [#2511](https://github.com/langchain-ai/langgraphjs/pull/2511) [`ef04db3`](https://github.com/langchain-ai/langgraphjs/commit/ef04db316d680ab32b812c88cadda75638294dd3) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(ToolNode): forward graph state to tools via `runtime.state`

  `ToolNode` now forwards its input to each tool through the second argument as `runtime.state`. When using `ToolNode` as a node in a LangGraph graph, this gives tools access to the current graph state for workflows that need tool-call support in LangGraph proper. Tools can type the second parameter as `ToolRuntime<StateType>` from `@langchain/core/tools` and read `runtime.state` directly. This works in every runtime, including web browsers, and removes the need for `getCurrentTaskInput()` (which relies on `node:async_hooks`/`AsyncLocalStorage`). `getCurrentTaskInput(config)` continues to work for backwards compatibility.

- Updated dependencies [[`3855985`](https://github.com/langchain-ai/langgraphjs/commit/3855985dd049739f145295d236ce6aa02ae2fb0e), [`7c3e9e9`](https://github.com/langchain-ai/langgraphjs/commit/7c3e9e93f3c7ec1dc654dac8ee8c03562ee8337b), [`17c44a3`](https://github.com/langchain-ai/langgraphjs/commit/17c44a38b7478e2bc4fe908a54c78ef33fb68ba3)]:
  - @langchain/langgraph-sdk@1.9.21

## 1.4.0

### Minor Changes

- [#2449](https://github.com/langchain-ai/langgraphjs/pull/2449) [`d12d269`](https://github.com/langchain-ai/langgraphjs/commit/d12d2693308e37951266bc8197daa656daa6e2aa) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Add cooperative, between-superstep graph draining via `RunControl`.

  A new `RunControl` (exported from `@langchain/langgraph`) exposes
  `requestDrain(reason)` plus read-only `drainRequested` / `drainReason`. Pass it
  through the new `control` option on `invoke` / `stream` / `streamEvents` (and the
  functional API). It is surfaced on `runtime.control`, so nodes can read it or call
  `requestDrain()` themselves, and it is propagated into subgraphs.

  When a drain is requested, the Pregel loop checks the flag at the top of each
  superstep (after the previous step's writes are applied and checkpointed): if more
  tasks remain it saves the checkpoint and throws the new `GraphDrained` error (also
  under `durability: "exit"`), so the run can be resumed later from the same config.
  If the graph naturally finishes on that tick it returns normally and the caller can
  inspect `control.drainRequested`. A drain requested inside a subgraph bubbles up and
  stops the parent at its next boundary. Draining never cancels work that is already
  running — pair it with an `AbortSignal` if you need a hard upper bound.

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

- [#2451](https://github.com/langchain-ai/langgraphjs/pull/2451) [`d65a920`](https://github.com/langchain-ai/langgraphjs/commit/d65a9209d7fad603f45562c2b28c3d25502c8318) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(langgraph): add node-level error handlers

  `StateGraph.addNode(name, fn, { errorHandler })` now accepts a first-class
  node-level error handler. The handler runs ONLY after the failing node's
  `retryPolicy` is exhausted, so retry and handling stay decoupled. It receives a
  typed `NodeError { node, error }` and the typed node input state, can return a
  state update, and can route to a recovery branch via `new Command({ goto })`
  (saga / compensation flows).

  Failure provenance is checkpointed (via a reserved `ERROR_SOURCE_NODE` write) so
  handlers observe the same context after a checkpoint resume. Uncaught node
  errors without a handler still abort the run as before, and `GraphBubbleUp`
  errors (such as `interrupt()`) are never swallowed by a handler.

  `StateGraph.setNodeDefaults({ errorHandler })` now also accepts a graph-wide
  default handler. It is materialized at `compile()` as a single shared handler
  and invoked for every regular node that does not set its own `errorHandler`. A
  per-node handler always takes precedence, the default never catches a failure
  raised by an error-handler node itself (handler failures fail the run), and the
  default is not inherited by subgraphs.

  Ports the Python feature from langchain-ai/langgraph#7233.

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

- [#2461](https://github.com/langchain-ai/langgraphjs/pull/2461) [`801d955`](https://github.com/langchain-ai/langgraphjs/commit/801d955d391f9fd9326a6696bff6c2f039883301) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Add `StateGraph.setNodeDefaults()` for setting graph-wide node policy defaults (`retryPolicy`, `cachePolicy`). Per-node values passed to `addNode` always take precedence, and defaults are resolved at `compile()` time so call order does not matter. Defaults are not inherited by subgraphs. Ports Python's `set_node_defaults()` (langchain-ai/langgraph#7747).

### Patch Changes

- [#2179](https://github.com/langchain-ai/langgraphjs/pull/2179) [`01c67df`](https://github.com/langchain-ai/langgraphjs/commit/01c67dfa4dfea98509d6e1f35fa16de8c5d6a7c4) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(core): time travel replay/fork for graphs with interrupts and subgraphs

  Ports Python fixes for stale RESUME writes during replay, wrong subgraph checkpoint loading during time travel, missing fork checkpoints on replay, and direct-to-subgraph time travel.

- [#2514](https://github.com/langchain-ai/langgraphjs/pull/2514) [`9e0201d`](https://github.com/langchain-ai/langgraphjs/commit/9e0201d8bd2d85490ca49e7e62126bda32b9121b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(schema): expose StateSchema JSON schemas for Studio introspection

  Route StateSchema runtime definitions through getJsonSchema() and
  getInputJsonSchema() so LangGraph Studio receives state, input, and
  context schemas when graphs use the StateSchema primitive.

  Fixes [#2466](https://github.com/langchain-ai/langgraphjs/issues/2466)

- [#2471](https://github.com/langchain-ai/langgraphjs/pull/2471) [`9b96f60`](https://github.com/langchain-ai/langgraphjs/commit/9b96f60af64c0d25f780cfe00c1cb7698f3b5773) Thanks [@christian-bromann](https://github.com/christian-bromann)! - perf(core): skip debug checkpoint snapshots when not streaming them

  Avoid building full-state `mapDebugCheckpoint` payloads on every tick when
  no consumer subscribed to `checkpoints` or `debug` stream modes. v3
  companion checkpoint envelopes are unchanged (they come from values metadata).

- [#2472](https://github.com/langchain-ai/langgraphjs/pull/2472) [`8e06ace`](https://github.com/langchain-ai/langgraphjs/commit/8e06ace95cd2279a8cf9d350f01268a253376dc9) Thanks [@christian-bromann](https://github.com/christian-bromann)! - perf(core): index pending writes for O(1) task-prep lookups

  Build a PendingWritesIndex once per \_prepareNextTasks call so resume and
  skip-done-task checks avoid repeated linear scans over checkpointPendingWrites.

- [#2473](https://github.com/langchain-ai/langgraphjs/pull/2473) [`a8b0036`](https://github.com/langchain-ai/langgraphjs/commit/a8b0036557333d16c95dfe51ccd61ee4cfdc600b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - perf(core): optimize applyWrites, interrupt seen, and channel errors

  Reduce allocations in \_applyWrites, fix O(N²) interrupt versions_seen updates,
  skip stack traces on EmptyChannelError control flow, and cache task lists in
  the pregel loop and runner.

- [#2444](https://github.com/langchain-ai/langgraphjs/pull/2444) [`4096933`](https://github.com/langchain-ai/langgraphjs/commit/4096933741e44d065e9b172f3bf86a621a88cc1e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(remote): add RemoteGraph v3 streaming support

  Expose the v3 `streamEvents` surface for `RemoteGraph` by adapting remote SDK thread streams to the local `GraphRunStream` shape.

- Updated dependencies [[`a8e7659`](https://github.com/langchain-ai/langgraphjs/commit/a8e7659a9d22fd84425aaf26bda88667c76b185a), [`2f6d873`](https://github.com/langchain-ai/langgraphjs/commit/2f6d87368e590ae2fc2a7990fd13cb0a5fe3c198)]:
  - @langchain/langgraph-checkpoint@1.1.0

## 1.3.7

### Patch Changes

- [#2505](https://github.com/langchain-ai/langgraphjs/pull/2505) [`cad31b4`](https://github.com/langchain-ai/langgraphjs/commit/cad31b42f001a87fcdf57c4c084c655c8762b6a5) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Add the `@langchain/langgraph/stream` entrypoint — a transport-agnostic backend toolkit for building custom servers on top of the v2 streaming protocol. Alongside the existing `StreamChannel` and `convertToProtocolEvent`, it exposes subscription primitives, typed against a minimal `MatchableEvent` shape so they work on both the core `ProtocolEvent` and the wire-level `Event` from `@langchain/protocol`:

  - `inferChannel(event)` — map an event to its subscription `Channel` (named `custom:<name>` channels included).
  - `matchesSubscription(event, definition)` — decide whether a buffered event should be delivered for a `SubscribeParams` filter, honoring channel, namespace prefix/depth, and an optional `since` replay cursor.
  - `isPrefixMatch(namespace, prefix)` / `normalizeNamespaceSegment(segment)` — namespace prefix matching with dynamic-suffix normalization (e.g. `fetcher:<uuid>` matches the `fetcher` prefix).
  - `SUPPORTED_CHANNELS` / `isSupportedChannel(value)` — the recognized channel set and a guard for validating subscription requests.

- Updated dependencies [[`cad31b4`](https://github.com/langchain-ai/langgraphjs/commit/cad31b42f001a87fcdf57c4c084c655c8762b6a5)]:
  - @langchain/langgraph-sdk@1.9.19

## 1.3.6

### Patch Changes

- [`658a076`](https://github.com/langchain-ai/langgraphjs/commit/658a076d5b50af9f5b96ab99f26ed629da6e182f) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(langgraph): forward named custom stream channels consistently

  Forward remote `StreamChannel` emissions as `custom:<name>` protocol events and normalize them back to custom-channel payloads in the API session. This aligns JavaScript stream-channel forwarding with the protocol subscription shape used by remote clients, so `custom:<name>` subscriptions receive extension channel data consistently.

- Updated dependencies [[`0a0e04e`](https://github.com/langchain-ai/langgraphjs/commit/0a0e04e9ff7e82fd08411cc0094e1f94729a1e1e), [`658a076`](https://github.com/langchain-ai/langgraphjs/commit/658a076d5b50af9f5b96ab99f26ed629da6e182f), [`a9aa8d6`](https://github.com/langchain-ai/langgraphjs/commit/a9aa8d6a9b23f5f7d4c56889fa68697b1e076b31)]:
  - @langchain/langgraph-sdk@1.9.17

## 1.3.5

### Patch Changes

- [#2489](https://github.com/langchain-ai/langgraphjs/pull/2489) [`e3a1933`](https://github.com/langchain-ai/langgraphjs/commit/e3a1933a8825a515d847b38b24a0743f4d418646) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(core): keep stream chunks as three-element tuples

  Emit lightweight checkpoint envelopes as separate
  `[namespace, "checkpoints", envelope]` chunks before paired `values` chunks.
  Public `stream()` always yields `[namespace, mode, payload]`; the v3
  protocol path surfaces envelopes via `convertToProtocolEvent`.

- Updated dependencies [[`244c24e`](https://github.com/langchain-ai/langgraphjs/commit/244c24eaccff4009df7d83e4320e51a4b310b15f)]:
  - @langchain/langgraph-sdk@1.9.16

## 1.3.4

### Patch Changes

- [#2035](https://github.com/langchain-ai/langgraphjs/pull/2035) [`7c3a98b`](https://github.com/langchain-ai/langgraphjs/commit/7c3a98b23af29fee0d9f064942abb71044ed0e51) Thanks [@JadenKim-dev](https://github.com/JadenKim-dev)! - fix(core): prevent Zod schema defaults from overwriting checkpoint state in Command.update

- Updated dependencies [[`0491534`](https://github.com/langchain-ai/langgraphjs/commit/04915347128e40fc9617647cadba6b472a357d36)]:
  - @langchain/langgraph-sdk@1.9.12

## 1.3.3

### Patch Changes

- [#2037](https://github.com/langchain-ai/langgraphjs/pull/2037) [`9eb478f`](https://github.com/langchain-ai/langgraphjs/commit/9eb478ffeeda2ad9c3bff2cd0f0ac602b0a79f4f) Thanks [@pawel-twardziak](https://github.com/pawel-twardziak)! - Decouple `ContextType` generic from `configurable` in `PregelOptions` so that providing a custom context type no longer incorrectly narrows the configurable parameter.

- [#2457](https://github.com/langchain-ai/langgraphjs/pull/2457) [`91a5494`](https://github.com/langchain-ai/langgraphjs/commit/91a54947155b3fad3234001e63e20099a63ed999) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(langgraph): pass context with stateful RemoteGraph runs

  Pop `thread_id` from run `config.configurable` and forward `context` to the SDK so checkpointed remote runs accept user context without a 400 from ambiguous parameters. Closes [#1922](https://github.com/langchain-ai/langgraphjs/issues/1922).

- [#1988](https://github.com/langchain-ai/langgraphjs/pull/1988) [`6d4bf92`](https://github.com/langchain-ai/langgraphjs/commit/6d4bf927e5cf3744034205528bcd09964949d6d7) Thanks [@Axadali](https://github.com/Axadali)! - Fix race condition in IterableReadableWritableStream.push() that caused ERR_INVALID_STATE errors when streaming with multiple parallel nodes and aborting the stream.

- [#2409](https://github.com/langchain-ai/langgraphjs/pull/2409) [`101b70a`](https://github.com/langchain-ai/langgraphjs/commit/101b70aa8d7ec26ec1654ef814689b832f1e17f3) Thanks [@pragnyanramtha](https://github.com/pragnyanramtha)! - Preserve non-plain objects passed through `Send` and `Command` argument deserialization.

- [#2344](https://github.com/langchain-ai/langgraphjs/pull/2344) [`0125920`](https://github.com/langchain-ai/langgraphjs/commit/0125920a2c4a87dc1d66aaf541ea16146f8cf842) Thanks [@dependabot](https://github.com/apps/dependabot)! - chore(deps): bump uuid to 14.0.0 and keep checkpoint ID ordering stable

  Bump `uuid` from 10.x/13.x to 14.0.0 across packages. Starting with uuid 11, `v6({ clockseq })` no longer advances the sub-millisecond time counter when an explicit `clockseq` is passed, so checkpoint IDs created within the same millisecond were ordered only by `clockseq`. Since checkpoint IDs are sorted lexicographically, this broke ordering — most visibly for the negative `clockseq` used by the first ("input") checkpoint, which sorted as the newest.

  `uuid6()` now maintains its own monotonic `(msecs, nsecs)` clock (mirroring uuid 10's internal v1 behavior) so the time component is always strictly increasing and checkpoint ordering no longer depends on the `clockseq` value. `emptyCheckpoint()` also uses a non-negative `clockseq`.

- Updated dependencies [[`863b555`](https://github.com/langchain-ai/langgraphjs/commit/863b555346de02c2c0be290e877b7d260a3f8856), [`0125920`](https://github.com/langchain-ai/langgraphjs/commit/0125920a2c4a87dc1d66aaf541ea16146f8cf842)]:
  - @langchain/langgraph-sdk@1.9.11
  - @langchain/langgraph-checkpoint@1.0.4

## 1.3.2

### Patch Changes

- [#2415](https://github.com/langchain-ai/langgraphjs/pull/2415) [`9d3c9dd`](https://github.com/langchain-ai/langgraphjs/commit/9d3c9dd3182059f9eca9fd9b14d8f7466b4338c4) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Move `@langchain/core` from a runtime dependency back to a required peer dependency so installing the SDK alone no longer pulls in `@langchain/core` (and `js-tiktoken`, etc.). Consumers that use streaming or message coercion must install `@langchain/core` explicitly or via `@langchain/langgraph`.

- Updated dependencies [[`9d3c9dd`](https://github.com/langchain-ai/langgraphjs/commit/9d3c9dd3182059f9eca9fd9b14d8f7466b4338c4)]:
  - @langchain/langgraph-sdk@1.9.4

## 1.3.1

### Patch Changes

- [#2339](https://github.com/langchain-ai/langgraphjs/pull/2339) [`2b88da4`](https://github.com/langchain-ai/langgraphjs/commit/2b88da497b2c6f8fbf8f4d901578a198824eb32f) Thanks [@vigneshpatel14](https://github.com/vigneshpatel14)! - fix(langgraph): surface structuredResponse parse failures in createReactAgent

- [#2406](https://github.com/langchain-ai/langgraphjs/pull/2406) [`e54ae90`](https://github.com/langchain-ai/langgraphjs/commit/e54ae901e119ccf81653b90d5a0db2485027a5a9) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(langgraph-core): keep tool results out of v3 message streams

- [#2376](https://github.com/langchain-ai/langgraphjs/pull/2376) [`4fd1e9f`](https://github.com/langchain-ai/langgraphjs/commit/4fd1e9f5720361a86a386a286ad8fcc824643280) Thanks [@hntrl](https://github.com/hntrl)! - fix(langgraph): prefer configurable assistant and graph IDs for runtime server info

  Update runtime `serverInfo` construction to read `assistant_id` and `graph_id` from
  `config.configurable` first, with fallback to `config.metadata` for compatibility.
  Also expands `execution_info` tests to cover configurable sourcing, precedence,
  and metadata fallback behavior.

- Updated dependencies [[`44746b1`](https://github.com/langchain-ai/langgraphjs/commit/44746b1a3b5b49737542b120b9e45d6f94181113), [`4cc6491`](https://github.com/langchain-ai/langgraphjs/commit/4cc6491844f21ed0fc737eaef8498133daa877f7), [`ae8af2d`](https://github.com/langchain-ai/langgraphjs/commit/ae8af2d75aef9a7bbd930d221d1ce03e7fbb90ad), [`01dd046`](https://github.com/langchain-ai/langgraphjs/commit/01dd0462ed300dee5a9a51f229e6c401315f070c), [`2ad1aa4`](https://github.com/langchain-ai/langgraphjs/commit/2ad1aa48c6a3f45340b4833e6de555fdc7348d15), [`75e651b`](https://github.com/langchain-ai/langgraphjs/commit/75e651b9cff1a1e39ad6513b8a5e9b565b9ad7fe), [`f1d651a`](https://github.com/langchain-ai/langgraphjs/commit/f1d651ae14ca178f4a915ac853ba9b439cd55ba3)]:
  - @langchain/langgraph-sdk@1.9.3

## 1.3.1-rc.0

### Patch Changes

- [#2376](https://github.com/langchain-ai/langgraphjs/pull/2376) [`4fd1e9f`](https://github.com/langchain-ai/langgraphjs/commit/4fd1e9f5720361a86a386a286ad8fcc824643280) Thanks [@hntrl](https://github.com/hntrl)! - fix(langgraph): prefer configurable assistant and graph IDs for runtime server info

  Update runtime `serverInfo` construction to read `assistant_id` and `graph_id` from
  `config.configurable` first, with fallback to `config.metadata` for compatibility.
  Also expands `execution_info` tests to cover configurable sourcing, precedence,
  and metadata fallback behavior.

- Updated dependencies [[`44746b1`](https://github.com/langchain-ai/langgraphjs/commit/44746b1a3b5b49737542b120b9e45d6f94181113), [`4cc6491`](https://github.com/langchain-ai/langgraphjs/commit/4cc6491844f21ed0fc737eaef8498133daa877f7), [`ae8af2d`](https://github.com/langchain-ai/langgraphjs/commit/ae8af2d75aef9a7bbd930d221d1ce03e7fbb90ad), [`2ad1aa4`](https://github.com/langchain-ai/langgraphjs/commit/2ad1aa48c6a3f45340b4833e6de555fdc7348d15), [`75e651b`](https://github.com/langchain-ai/langgraphjs/commit/75e651b9cff1a1e39ad6513b8a5e9b565b9ad7fe), [`f1d651a`](https://github.com/langchain-ai/langgraphjs/commit/f1d651ae14ca178f4a915ac853ba9b439cd55ba3)]:
  - @langchain/langgraph-sdk@1.9.3-rc.0

## 1.3.0

### Minor Changes

- [#2314](https://github.com/langchain-ai/langgraphjs/pull/2314) [`085a07f`](https://github.com/langchain-ai/langgraphjs/commit/085a07f569b6d7d79728eb7eb6eb3a0c67fcdefb) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Add the in-process event streaming runtime behind `streamEvents`.

  LangGraph now exposes the core primitives for event-based streaming, including
  `StreamChannel`, `StreamMux`, `GraphRunStream`, `SubgraphRunStream`, native
  stream transformers, and protocol event conversion utilities. These APIs let
  graphs emit ordered protocol events, derive additional projections, expose
  custom stream channels, and bridge in-process runs to remote SDK clients.

  The runtime includes built-in transformers for messages, values, lifecycle
  events, and subgraph discovery. It also adds support for transformer
  registration during graph execution, forwarding remote `StreamChannel` output,
  subgraph-aware event routing, event log multiplexing, and checkpoint-aware
  values streams.

  This release also expands test coverage across Pregel streaming, event
  conversion, stream muxing, stream channels, run streams, lifecycle
  transformers, subgraph transformers, and type-level streaming behavior.

### Patch Changes

- Updated dependencies [[`085a07f`](https://github.com/langchain-ai/langgraphjs/commit/085a07f569b6d7d79728eb7eb6eb3a0c67fcdefb), [`085a07f`](https://github.com/langchain-ai/langgraphjs/commit/085a07f569b6d7d79728eb7eb6eb3a0c67fcdefb), [`d1e2fda`](https://github.com/langchain-ai/langgraphjs/commit/d1e2fda1b1165e122362780a62ab8d2ebff9f9b9)]:
  - @langchain/langgraph-checkpoint@1.0.2
  - @langchain/langgraph-sdk@1.9.0

## 1.2.9

### Patch Changes

- [#2315](https://github.com/langchain-ai/langgraphjs/pull/2315) [`9102d52`](https://github.com/langchain-ai/langgraphjs/commit/9102d526c858a4cdbe9b47dcdd062b93da93e49f) Thanks [@hntrl](https://github.com/hntrl)! - propagate tracer metadata defaults from configurable

- [#2311](https://github.com/langchain-ai/langgraphjs/pull/2311) [`b7c196b`](https://github.com/langchain-ai/langgraphjs/commit/b7c196b2142fb888dfcd9ceb1dfb4365d803c8b6) Thanks [@open-swe](https://github.com/apps/open-swe)! - fix: export missing types for typescript 6.0 declaration file compatibility

- Updated dependencies [[`458d66b`](https://github.com/langchain-ai/langgraphjs/commit/458d66bf665468854abb8133594d4d4f966054ed)]:
  - @langchain/langgraph-sdk@1.8.9

## 1.2.8

### Patch Changes

- [#2275](https://github.com/langchain-ai/langgraphjs/pull/2275) [`e42c2c8`](https://github.com/langchain-ai/langgraphjs/commit/e42c2c8836e0b7e36067fea6cc51842e1eb2c60f) Thanks [@open-swe](https://github.com/apps/open-swe)! - enhance runtime with executionInfo and serverInfo

## 1.2.7

### Patch Changes

- [#2281](https://github.com/langchain-ai/langgraphjs/pull/2281) [`2b62610`](https://github.com/langchain-ai/langgraphjs/commit/2b626107101bddb13cf662e1583ea1a828c6e0cd) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(sdk): support for headless tools

## 1.2.6

### Patch Changes

- [#2241](https://github.com/langchain-ai/langgraphjs/pull/2241) [`6ee23e8`](https://github.com/langchain-ai/langgraphjs/commit/6ee23e819b5da43a5a0c62560f85a9037a427630) Thanks [@pawel-twardziak](https://github.com/pawel-twardziak)! - feat: add browser support for interrupt, writer, and other Node-only exports

  Export `interrupt`, `writer`, `pushMessage`, `getStore`, `getWriter`, `getConfig`, `getPreviousState`, `getCurrentTaskInput` from `web.ts` and add a `"browser"` condition to the `"."` package export so browser bundlers resolve to `web.js` instead of pulling in `node:async_hooks`.

- [#2245](https://github.com/langchain-ai/langgraphjs/pull/2245) [`77af976`](https://github.com/langchain-ai/langgraphjs/commit/77af97650c0f1671338911994c2e355b29489528) Thanks [@hntrl](https://github.com/hntrl)! - revert abort signal change that was causing problematic errors

- [#2242](https://github.com/langchain-ai/langgraphjs/pull/2242) [`bdcf290`](https://github.com/langchain-ai/langgraphjs/commit/bdcf290198ce5cea4367ee8c9f1cbbbcf14d05e4) Thanks [@hntrl](https://github.com/hntrl)! - clean up resolved checkpointer promises to reduce memory retention

- Updated dependencies [[`88726df`](https://github.com/langchain-ai/langgraphjs/commit/88726dfe222aed64e5cd5dfa6f77f886b5a0d205), [`7dfcbff`](https://github.com/langchain-ai/langgraphjs/commit/7dfcbffd4805b2b4cc41f07f30be57ed732786b4)]:
  - @langchain/langgraph-sdk@1.8.1

## 1.2.5

### Patch Changes

- [#2213](https://github.com/langchain-ai/langgraphjs/pull/2213) [`a09932a`](https://github.com/langchain-ai/langgraphjs/commit/a09932a203062d52e98e6dc5fd80ab572b123700) Thanks [@hntrl](https://github.com/hntrl)! - fix(core): prevent AbortSignal listener leak in stream() and streamEvents()

  `Pregel.stream()` and `streamEvents()` called `combineAbortSignals()` but discarded the `dispose` function, leaking one abort listener on the caller's signal per invocation. Over many invocations this caused unbounded memory growth as each leaked listener retained references to its associated graph execution state.

  - Use `AbortSignal.any()` on Node 20+ which handles listener lifecycle automatically via GC
  - Fall back to manual listener management on Node 18, with proper `dispose()` called when the stream completes or is cancelled

- [#2210](https://github.com/langchain-ai/langgraphjs/pull/2210) [`4d2e948`](https://github.com/langchain-ai/langgraphjs/commit/4d2e9483208e105b7c45ab1cbc8ac8d540fbb23d) Thanks [@jackjin1997](https://github.com/jackjin1997)! - Fix `AnyValue.update()` returning `false` instead of `true` when values are received, aligning with all other channel implementations.

- Updated dependencies [[`414a7ad`](https://github.com/langchain-ai/langgraphjs/commit/414a7adf908ba4f7ffef4985df3a95f14202591b)]:
  - @langchain/langgraph-sdk@1.8.0

## 1.2.4

### Patch Changes

- [`fe4dd5b`](https://github.com/langchain-ai/langgraphjs/commit/fe4dd5b85d285f78b6d499b1f1013927931ea634) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): fetch subagent history

- Updated dependencies [[`fe4dd5b`](https://github.com/langchain-ai/langgraphjs/commit/fe4dd5b85d285f78b6d499b1f1013927931ea634), [`fe4dd5b`](https://github.com/langchain-ai/langgraphjs/commit/fe4dd5b85d285f78b6d499b1f1013927931ea634), [`fe4dd5b`](https://github.com/langchain-ai/langgraphjs/commit/fe4dd5b85d285f78b6d499b1f1013927931ea634)]:
  - @langchain/langgraph-sdk@1.7.5

## 1.2.3

### Patch Changes

- [#2176](https://github.com/langchain-ai/langgraphjs/pull/2176) [`ad48dee`](https://github.com/langchain-ai/langgraphjs/commit/ad48dee9dcaf29c718c9f6b1c188756c14e85a0f) Thanks [@pawel-twardziak](https://github.com/pawel-twardziak)! - fix(state): merge jsonSchemaExtra in getInputJsonSchema()

- Updated dependencies [[`8fec72a`](https://github.com/langchain-ai/langgraphjs/commit/8fec72ae98b117b79048403d0f7ad75d653c090b), [`a9ff2ef`](https://github.com/langchain-ai/langgraphjs/commit/a9ff2efdf0a2b6ff0301eedfff541e125c1e6300), [`a24bb55`](https://github.com/langchain-ai/langgraphjs/commit/a24bb550fb81271c505b9cab0295d8e599aaeb79), [`b80076c`](https://github.com/langchain-ai/langgraphjs/commit/b80076c5a7fc1b6985abc1fd9c367438ba6ca968), [`b6cfe55`](https://github.com/langchain-ai/langgraphjs/commit/b6cfe555bfb498fe24fa85847f0fe5d1194dfa39)]:
  - @langchain/langgraph-sdk@1.7.3
  - @langchain/langgraph-checkpoint@1.0.1

## 1.2.2

### Patch Changes

- Updated dependencies [[`e051ef6`](https://github.com/langchain-ai/langgraphjs/commit/e051ef6aa8301f39badc9f496cbacef73bb4e2c4)]:
  - @langchain/langgraph-sdk@1.7.0

## 1.2.1

### Patch Changes

- [#2024](https://github.com/langchain-ai/langgraphjs/pull/2024) [`b1272bd`](https://github.com/langchain-ai/langgraphjs/commit/b1272bd43ab6fad2b162de13f62ceb1be234aa6f) Thanks [@hntrl](https://github.com/hntrl)! - fix: add explicit `: symbol` type annotations for cross-version compatibility

  TypeScript infers `unique symbol` type when Symbol.for() is used without an explicit type annotation, causing type incompatibility when multiple versions of the same package are present in a dependency tree. By adding explicit `: symbol` annotations, all declarations now use the general symbol type, making them compatible across versions while maintaining identical runtime behavior.

  Changes:

  - Added `: symbol` to `COMMAND_SYMBOL` (used on CommandInstance class)
  - Added `: symbol` to `REDUCED_VALUE_SYMBOL` (exported, used on ReducedValue class)
  - Added `: symbol` to `UNTRACKED_VALUE_SYMBOL` (exported, used on UntrackedValue class)
  - Fixed TypeScript indexing error by using `Record<symbol, unknown>` type assertion in ReducedValue.isInstance()

## 1.2.0

### Minor Changes

- [#2002](https://github.com/langchain-ai/langgraphjs/pull/2002) [`fce9d38`](https://github.com/langchain-ai/langgraphjs/commit/fce9d38267e7d99029646cfcf7abb78c7b937e34) Thanks [@hntrl](https://github.com/hntrl)! - feat(langgraph): add Overwrite class for bypassing channel reducers

  Adds an `Overwrite` class and `OverwriteValue` type that allow nodes to bypass reducers in `BinaryOperatorAggregate` channels, writing values directly instead of passing them through the reducer function. This is useful when a node needs to replace accumulated state rather than append to it.

  - New `Overwrite` class exported from `@langchain/langgraph`
  - `BinaryOperatorAggregate` channel detects `OverwriteValue` and sets the value directly
  - `Annotation`, `StateSchema`, and zod schema type mappings updated to include `OverwriteValue` in update types

### Patch Changes

- [#1992](https://github.com/langchain-ai/langgraphjs/pull/1992) [`937f780`](https://github.com/langchain-ai/langgraphjs/commit/937f78030f1360251361c6096bbd0ff287662a2b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(core): don't trace channel read/writes

- [#1984](https://github.com/langchain-ai/langgraphjs/pull/1984) [`aa8e878`](https://github.com/langchain-ai/langgraphjs/commit/aa8e878e5b71128685ab7e7a79c96bd2519c0123) Thanks [@colifran](https://github.com/colifran)! - feat: add tools stream mode for tool lifecycle events

- Updated dependencies [[`aa8e878`](https://github.com/langchain-ai/langgraphjs/commit/aa8e878e5b71128685ab7e7a79c96bd2519c0123), [`1b088e5`](https://github.com/langchain-ai/langgraphjs/commit/1b088e578aaef7d231f37885b94bfd763f99a775)]:
  - @langchain/langgraph-sdk@1.6.5

## 1.1.5

### Patch Changes

- Updated dependencies [[`242cfbb`](https://github.com/langchain-ai/langgraphjs/commit/242cfbbb6ab375c91bd021f64ec652840af591a9)]:
  - @langchain/langgraph-sdk@2.0.0

## 1.1.4

### Patch Changes

- Updated dependencies [[`8d5c2d6`](https://github.com/langchain-ai/langgraphjs/commit/8d5c2d688d330012638d8f34ce20a454600ebc1b)]:
  - @langchain/langgraph-sdk@1.6.0

## 1.1.3

### Patch Changes

- [#1932](https://github.com/langchain-ai/langgraphjs/pull/1932) [`0cda1f3`](https://github.com/langchain-ai/langgraphjs/commit/0cda1f3b78a86e7809b7db15a7ff0ea00ee1ecd8) Thanks [@samecrowder](https://github.com/samecrowder)! - fix: preserve `langgraph_type` metadata for LangSmith Studio tab detection

  - **Zod v4 `.register()` fix**: The metadata registry now properly stores and retrieves `langgraph_type` metadata when using Zod v4's `.register()` method with `MessagesZodMeta`
  - **StateSchema fix**: `StateSchema.getJsonSchema()` now correctly includes `jsonSchemaExtra` (like `langgraph_type: "messages"`) even when the underlying schema (e.g., `z.custom()`) doesn't produce a JSON schema

## 1.1.2

### Patch Changes

- [#1914](https://github.com/langchain-ai/langgraphjs/pull/1914) [`e60ec1b`](https://github.com/langchain-ai/langgraphjs/commit/e60ec1be6efc3b7fd1bde907de3d1d08fa2a0262) Thanks [@hntrl](https://github.com/hntrl)! - fix ConditionalEdgeRouter type rejection

- [#1916](https://github.com/langchain-ai/langgraphjs/pull/1916) [`9f34c8c`](https://github.com/langchain-ai/langgraphjs/commit/9f34c8ce420f44c604f12468806be807f7b372c1) Thanks [@hntrl](https://github.com/hntrl)! - Add unified schema support for `StateGraph` constructor

  - Support mixing `AnnotationRoot`, Zod schemas, and `StateSchema` for state, input, and output definitions
  - Add `{ input, output }` only pattern where state is inferred from input schema
  - Add per-node input schema support via `addNode` options
  - Deprecate `stateSchema` property in favor of `state`
  - Simplify constructor overloads with unified `StateGraphInit` type

- [#1918](https://github.com/langchain-ai/langgraphjs/pull/1918) [`cc12263`](https://github.com/langchain-ai/langgraphjs/commit/cc12263ad26804ef53760cabf1bd2fda0be575d6) Thanks [@hntrl](https://github.com/hntrl)! - Add type bag pattern for `GraphNode` and `ConditionalEdgeRouter` type utilities.

  **New types:**

  - `GraphNodeTypes<InputSchema, OutputSchema, ContextSchema, Nodes>` - Type bag interface for GraphNode
  - `GraphNodeReturnValue<Update, Nodes>` - Return type helper for node functions
  - `ConditionalEdgeRouterTypes<InputSchema, ContextSchema, Nodes>` - Type bag interface for ConditionalEdgeRouter

  **Usage:**

  Both `GraphNode` and `ConditionalEdgeRouter` now support two patterns:

  1. **Single schema** (backward compatible):

     ```typescript
     const node: GraphNode<typeof AgentState, MyContext, "agent" | "tool"> = ...
     ```

  2. **Type bag pattern** (new):
     ```typescript
     const node: GraphNode<{
       InputSchema: typeof InputSchema;
       OutputSchema: typeof OutputSchema;
       ContextSchema: typeof ContextSchema;
       Nodes: "agent" | "tool";
     }> = (state, runtime) => {
       // state type inferred from InputSchema
       // return type validated against OutputSchema
       // runtime.configurable type inferred from ContextSchema
       return { answer: "response" };
     };
     ```

  The type bag pattern enables nodes that receive a subset of state fields and return different fields, with full type safety.

## 1.1.1

### Patch Changes

- [#1912](https://github.com/langchain-ai/langgraphjs/pull/1912) [`4b2e448`](https://github.com/langchain-ai/langgraphjs/commit/4b2e448ed7c05be3a5f2cb07b28f3fabe4079c01) Thanks [@hntrl](https://github.com/hntrl)! - fix StateSchema/ReducedValue type inference

- Updated dependencies [[`98c0f26`](https://github.com/langchain-ai/langgraphjs/commit/98c0f26f4cc2c246359914704278ff5e3ae46a01), [`a3669be`](https://github.com/langchain-ai/langgraphjs/commit/a3669be176c5bca4b5bbcc6a6245882a684fb12f)]:
  - @langchain/langgraph-sdk@1.5.5

## 1.1.0

### Minor Changes

- [#1852](https://github.com/langchain-ai/langgraphjs/pull/1852) [`2ea3128`](https://github.com/langchain-ai/langgraphjs/commit/2ea3128ac48e52c9a180a9eb9d978dd9067ac80e) Thanks [@hntrl](https://github.com/hntrl)! - feat: add type utilities for authoring graph nodes and conditional edges

  New exported type utilities for improved TypeScript ergonomics:

  - `ExtractStateType<Schema>` - Extract the State type from any supported schema (StateSchema, AnnotationRoot, or Zod object)
  - `ExtractUpdateType<Schema>` - Extract the Update type (partial state for node returns) from any supported schema
  - `GraphNode<Schema, Context?, Nodes?>` - Strongly-typed utility for defining graph node functions with full inference for state, runtime context, and optional type-safe routing via Command
  - `ConditionalEdgeRouter<Schema, Context?, Nodes?>` - Type for conditional edge routing functions passed to `addConditionalEdges`

  These utilities enable defining nodes outside the StateGraph builder while maintaining full type safety:

  ```typescript
  import {
    StateSchema,
    GraphNode,
    ConditionalEdgeRouter,
    END,
  } from "@langchain/langgraph";
  import { z } from "zod/v4";

  const AgentState = new StateSchema({
    messages: MessagesValue,
    step: z.number().default(0),
  });

  interface MyContext {
    userId: string;
  }

  // Fully typed node function
  const processNode: GraphNode<typeof AgentState> = (state, runtime) => {
    return { step: state.step + 1 };
  };

  // Type-safe routing with Command
  const routerNode: GraphNode<
    typeof AgentState,
    MyContext,
    "agent" | "tool"
  > = (state) => new Command({ goto: state.needsTool ? "tool" : "agent" });

  // Conditional edge router
  const router: ConditionalEdgeRouter<
    typeof AgentState,
    MyContext,
    "continue"
  > = (state) => (state.done ? END : "continue");
  ```

- [#1842](https://github.com/langchain-ai/langgraphjs/pull/1842) [`7ddf854`](https://github.com/langchain-ai/langgraphjs/commit/7ddf85468f01b8cfea62b1c513e04bd578580444) Thanks [@hntrl](https://github.com/hntrl)! - feat: `StateSchema`, `ReducedValue`, and `UntrackedValue`

  **StateSchema** provides a new API for defining graph state that works with any [Standard Schema](https://github.com/standard-schema/standard-schema)-compliant validation library (Zod, Valibot, ArkType, and others).

  ### Standard Schema support

  LangGraph now supports [Standard Schema](https://standardschema.dev/), an open specification implemented by Zod 4, Valibot, ArkType, and other schema libraries. This means you can use your preferred validation library without lock-in:

  ```typescript
  import { z } from "zod"; // or valibot, arktype, etc.
  import {
    StateSchema,
    ReducedValue,
    MessagesValue,
  } from "@langchain/langgraph";

  const AgentState = new StateSchema({
    messages: MessagesValue,
    currentStep: z.string(),
    count: z.number().default(0),
    history: new ReducedValue(
      z.array(z.string()).default(() => []),
      {
        inputSchema: z.string(),
        reducer: (current, next) => [...current, next],
      }
    ),
  });

  // Type-safe state and update types
  type State = typeof AgentState.State;
  type Update = typeof AgentState.Update;

  const graph = new StateGraph(AgentState)
    .addNode("agent", (state) => ({ count: state.count + 1 }))
    .addEdge(START, "agent")
    .addEdge("agent", END)
    .compile();
  ```

  ### New exports

  - **`StateSchema`** - Define state with any Standard Schema-compliant library
  - **`ReducedValue`** - Define fields with custom reducer functions for accumulating state
  - **`UntrackedValue`** - Define transient fields that are not persisted to checkpoints
  - **`MessagesValue`** - Pre-built message list channel with add/remove semantics

### Patch Changes

- [#1901](https://github.com/langchain-ai/langgraphjs/pull/1901) [`6d8f3ed`](https://github.com/langchain-ai/langgraphjs/commit/6d8f3ed4c879419d941a25ee48bed0d5545add4d) Thanks [@dqbd](https://github.com/dqbd)! - Perform reference equality check on reducers before throwing "Channel already exists with a different type" error

- Updated dependencies [[`5629d46`](https://github.com/langchain-ai/langgraphjs/commit/5629d46362509f506ab455389e600eff7d9b34bb), [`78743d6`](https://github.com/langchain-ai/langgraphjs/commit/78743d6bca96945d574713ffefe32b04a4c04d29)]:
  - @langchain/langgraph-sdk@1.5.4

## 1.0.15

### Patch Changes

- Updated dependencies [[`344b2d2`](https://github.com/langchain-ai/langgraphjs/commit/344b2d2c1a6dca43e9b01e436b00bca393bc9538), [`84a636e`](https://github.com/langchain-ai/langgraphjs/commit/84a636e52f7d3a4b97ae69d050efd9ca0224c6ca), [`2b9f3ee`](https://github.com/langchain-ai/langgraphjs/commit/2b9f3ee83d0b8ba023e7a52b938260af3f6433d4)]:
  - @langchain/langgraph-sdk@1.5.0

## 1.0.14

### Patch Changes

- [#1862](https://github.com/langchain-ai/langgraphjs/pull/1862) [`e7aeffe`](https://github.com/langchain-ai/langgraphjs/commit/e7aeffeb72aaccd8c94f8e78708f747ce21bf23c) Thanks [@dqbd](https://github.com/dqbd)! - retry release: improved Zod interop

- Updated dependencies [[`e7aeffe`](https://github.com/langchain-ai/langgraphjs/commit/e7aeffeb72aaccd8c94f8e78708f747ce21bf23c)]:
  - @langchain/langgraph-sdk@1.4.6

## 1.0.13

### Patch Changes

- [#1856](https://github.com/langchain-ai/langgraphjs/pull/1856) [`a9fa28b`](https://github.com/langchain-ai/langgraphjs/commit/a9fa28b6adad16050fcf5d5876a3924253664217) Thanks [@christian-bromann](https://github.com/christian-bromann)! - retry release: improved Zod interop

- Updated dependencies [[`a9fa28b`](https://github.com/langchain-ai/langgraphjs/commit/a9fa28b6adad16050fcf5d5876a3924253664217)]:
  - @langchain/langgraph-sdk@1.4.5

## 1.0.12

### Patch Changes

- [#1853](https://github.com/langchain-ai/langgraphjs/pull/1853) [`a84c1ff`](https://github.com/langchain-ai/langgraphjs/commit/a84c1ff18289653ff4715bd0db4ac3d06600556e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - retry release: improved Zod interop

- Updated dependencies [[`a84c1ff`](https://github.com/langchain-ai/langgraphjs/commit/a84c1ff18289653ff4715bd0db4ac3d06600556e)]:
  - @langchain/langgraph-sdk@1.4.4

## 1.0.11

### Patch Changes

- [#1850](https://github.com/langchain-ai/langgraphjs/pull/1850) [`e9f7e8e`](https://github.com/langchain-ai/langgraphjs/commit/e9f7e8e9e6b8851cb7dd68e31d2f1867b62bd6bd) Thanks [@christian-bromann](https://github.com/christian-bromann)! - retry release: improved Zod interop

- Updated dependencies [[`e9f7e8e`](https://github.com/langchain-ai/langgraphjs/commit/e9f7e8e9e6b8851cb7dd68e31d2f1867b62bd6bd)]:
  - @langchain/langgraph-sdk@1.4.3

## 1.0.10

### Patch Changes

- 3ec85a4: retry release: improved Zod interop
- Updated dependencies [3ec85a4]
  - @langchain/langgraph-sdk@1.4.2

## 1.0.9

### Patch Changes

- 3613386: retry release: improved Zod interop
- Updated dependencies [3613386]
  - @langchain/langgraph-sdk@1.4.1

## 1.0.8

### Patch Changes

- 730dc7c: fix(core): improved Zod interop
- Updated dependencies [730dc7c]
- Updated dependencies [4ffdde9]
- Updated dependencies [730dc7c]
  - @langchain/langgraph-sdk@1.4.0

## 1.0.7

### Patch Changes

- f602df6: Adding support for resumableStreams on remote graphs.

## 1.0.6

### Patch Changes

- de1454a: undeprecate toolsCondition
- 2340a54: respect meta defaults in `LastValue`

## 1.0.5

### Patch Changes

- Updated dependencies [1497df9]
  - @langchain/langgraph-sdk@1.3.0

## 1.0.4

### Patch Changes

- Updated dependencies [379de5e]
- Updated dependencies [d08e484]
- Updated dependencies [d08e484]
  - @langchain/langgraph-sdk@1.2.0

## 1.0.3

### Patch Changes

- Updated dependencies [e19e76c]
- Updated dependencies [fa6c009]
- Updated dependencies [35e8fc7]
- Updated dependencies [b78a738]
  - @langchain/langgraph-sdk@1.1.0

## 1.0.2

### Patch Changes

- 4a6bde2: remove interrupt deprecations docs

## 1.0.1

### Patch Changes

- 4c4125c: undeprecate `ToolNode`

## 1.0.0

### Major Changes

- 1e1ecbb: Make Zod a peer dependency of @langchain/langgraph
- 1e1ecbb: This release updates the package for compatibility with LangGraph v1.0. See the [v1.0 release notes](https://docs.langchain.com/oss/javascript/releases/langgraph-v1) for details on what's new.

### Patch Changes

- 1e1ecbb: Fix type issue with defining `interrupt` and `writer` in StateGraph constructor when using Annotation.Root
- 1e1ecbb: Add `pushMessage` method for manually publishing to messages stream channel
- 1e1ecbb: chore(prebuilt): deprecate createReactAgent
- 1e1ecbb: Improve performance of scheduling tasks with large graphs
- 1e1ecbb: Improve graph execution performance by avoiding unnecessary cloning of checkpoints after every tick
- 1e1ecbb: fix(@langchain/langgraph): export missing `CommandParams` symbol
- 1e1ecbb: Add `stream.encoding` option to emit LangGraph API events as Server-Sent Events. This allows for sending events through the wire by piping the stream to a `Response` object.
- 1e1ecbb: fix(@langchain/langgraph): export missing `CommandInstance` symbol
- 1e1ecbb: Update troubleshooting link for common errors, add MISSING_CHECKPOINTER troubleshooting page
- 1e1ecbb: Fix `stateKey` property in `pushMessage` being ignored when RunnableConfig is automatically inherited
- 1e1ecbb: Improve tick performance by detecting interrupts faster within a tick.
- 1e1ecbb: Improve tick performance by calling `maxChannelMapVersion` only once
- 1e1ecbb: feat(langgraph): add `toLangGraphEventStream` method to stream events in LGP compatible format
- 1e1ecbb: fix(createReactAgent): update deprecation messages to contain reactAgent
- 1e1ecbb: `writer`, `interrupt` and `signal` is no longer an optional property of `Runtime`
- 1e1ecbb: Add support for defining multiple interrupts in StateGraph constructor. Interrupts from the map can be picked from the `Runtime` object, ensuring type-safety across multiple interrupts.
- 1e1ecbb: Channels are now part of the public API, allowing users to customise behaviour of checkpointing per channel (#976)
- 1e1ecbb: Allow defining types for interrupt and custom events upfront
- 1e1ecbb: Fix performance regression due to deferred nodes
- Updated dependencies [1e1ecbb]
  - @langchain/langgraph-checkpoint@1.0.0
  - @langchain/langgraph-sdk@1.0.0

## 1.0.0-alpha.5

### Patch Changes

- b6d6701: fix(@langchain/langgraph): export missing `CommandParams` symbol
- d5be09c: fix(@langchain/langgraph): export missing `CommandInstance` symbol

## 1.0.0-alpha.4

### Patch Changes

- c3f326d: Add support for defining multiple interrupts in StateGraph constructor. Interrupts from the map can be picked from the `Runtime` object, ensuring type-safety across multiple interrupts.

## 1.0.0-alpha.3

### Patch Changes

- 05619e2: Add `stream.encoding` option to emit LangGraph API events as Server-Sent Events. This allows for sending events through the wire by piping the stream to a `Response` object.
- 14cb042: Fix `stateKey` property in `pushMessage` being ignored when RunnableConfig is automatically inherited

## 1.0.0-alpha.2

### Patch Changes

- a5bcd74: Fix type issue with defining `interrupt` and `writer` in StateGraph constructor when using Annotation.Root
- 5184725: Add `pushMessage` method for manually publishing to messages stream channel

## 1.0.0-alpha.1

### Patch Changes

- a05436d: Improve performance of scheduling tasks with large graphs
- d35db59: Improve graph execution performance by avoiding unnecessary cloning of checkpoints after every tick
- 7e01d08: Update troubleshooting link for common errors, add MISSING_CHECKPOINTER troubleshooting page
- a527fc7: Improve tick performance by detecting interrupts faster within a tick.
- 27934c0: Improve tick performance by calling `maxChannelMapVersion` only once
- dc2e5f2: fix(createReactAgent): update deprecation messages to contain reactAgent
- e8f5084: `writer`, `interrupt` and `signal` is no longer an optional property of `Runtime`
- 20f1d64: Channels are now part of the public API, allowing users to customise behaviour of checkpointing per channel (#976)
- 2311efc: Allow defining types for interrupt and custom events upfront
- c6f75b6: Fix performance regression due to deferred nodes

## 1.0.0-alpha.0

### Major Changes

- 445c2ae: Make Zod a peer dependency of @langchain/langgraph

### Patch Changes

- 5f9b5a0: Deprecate createReactAgent in favour of `langchain` package.
- dcc117f: feat(langgraph): add `toLangGraphEventStream` method to stream events in LGP compatible format

## 0.4.9

### Patch Changes

- Updated dependencies [35a0f1c]
- Updated dependencies [35a0f1c]
- Updated dependencies [35a0f1c]
- Updated dependencies [35a0f1c]
  - @langchain/langgraph-sdk@0.1.0

## 0.4.8

### Patch Changes

- bb0df7c: Fix "This stream has already been locked for exclusive reading by another reader" error when using `web-streams-polyfill`

## 0.4.7

### Patch Changes

- 60e9258: fix(langgraph): task result from stream mode debug / tasks should match format from getStateHistory / getState
- 07a5b2f: fix(langgraph): avoid accepting incorrect keys in withLangGraph
- Updated dependencies [b5f14d0]
  - @langchain/langgraph-sdk@0.0.111

## 0.4.6

### Patch Changes

- 5f1db81: fix(langgraph): `withConfig` should accept `context`
- c53ca47: Avoid iterating on channels if no managed values are present
- a3707fb: fix(langgraph): allow `updateState` after resuming from an interrupt
- Updated dependencies [e8b4540]
- Updated dependencies [9c57526]
  - @langchain/langgraph-sdk@0.0.109

## 0.4.5

### Patch Changes

- d22113a: fix(pregel/utils): propagate abort reason in combineAbortSignals
- 2284045: fix(langgraph): send checkpoint namespace when yielding custom events in subgraphs
- 4774013: fix(langgraph): persist resume map values

## 0.4.4

### Patch Changes

- 8f4acc0: feat(langgraph): speed up prepareSingleTask by 20x
- 8152a15: Use return type of nodes for streamMode: updates types
- 4e854b2: fix(langgraph): set status for tool messages generated by ToolNode
- cb4b17a: feat(langgraph): use createReactAgent description for supervisor agent handoffs
- Updated dependencies [72386a4]
- Updated dependencies [3ee5c20]
  - @langchain/langgraph-sdk@0.0.107

## 0.4.3

### Patch Changes

- f69bf6d: feat(langgraph): createReactAgent v2: use Send for each of the tool calls
- 9940200: feat(langgraph): Allow partially applying tool calls via postModelHook
- e8c61bb: feat(langgraph): add dynamic model choice to createReactAgent

## 0.4.2

### Patch Changes

- c911c5f: fix(langgraph): handle empty messages

## 0.4.1

### Patch Changes

- f2cc704: fix(langgraph): RemotePregel serialization fix
- Updated dependencies [7054a6a]
  - @langchain/langgraph-sdk@0.0.105

## 0.4.0

### Minor Changes

- 5f7ee26: feat(langgraph): cleanup of interrupt interface
- 10432a4: chore(langgraph): remove SharedValue / managed values
- f1bcec7: chore(langgraph): introduce `context` field and `Runtime` type
- 14dd523: fix(langgraph): auto-inference of configurable fields
- fa78796: Add `durability` checkpointer mode
- 565f472: Mark StateGraph({ channel }) constructor deprecated

### Patch Changes

- Updated dependencies [ccbcbc1]
- Updated dependencies [10f292a]
- Updated dependencies [f1bcec7]
- Updated dependencies [3fd7f73]
- Updated dependencies [773ec0d]
  - @langchain/langgraph-checkpoint@0.1.0
  - @langchain/langgraph-sdk@0.0.103

## 0.3.12

### Patch Changes

- 034730f: fix(langgraph): add support for new interrupt ID

## 0.3.11

### Patch Changes

- a0efb98: Relax `when` type for `Interrupt`
- Updated dependencies [a0efb98]
  - @langchain/langgraph-sdk@0.0.100

## 0.3.10

### Patch Changes

- a12c1fb: fix(langgraph): stop suggesting public properties and methods of Command when calling invoke
- Updated dependencies [ee1defa]
  - @langchain/langgraph-sdk@0.0.98

## 0.3.9

### Patch Changes

- 430ae93: feat(langgraph): validate if messages present in user provided schema
- 4aed3f4: fix(langgraph): dispose unused combined signals
- 02f9e02: fix(langgraph): preModelHook `llmInputMessages` should not keep concatenating messages
- 6e616f5: fix(langgraph): respect strict option in responseFormat inside createReactAgent
- 6812b50: feat(langgraph): allow extending state with Zod schema
- 8166703: add UpdateType type utility for Zod, improve Zod 4 and Zod 4 mini support
- Updated dependencies [53b8c30]
  - @langchain/langgraph-sdk@0.0.96

## 0.3.8

### Patch Changes

- fix(langgraph): Ensure resuming only happens with matching run ids by @hinthornw in https://github.com/langchain-ai/langgraphjs/pull/1381

## 0.3.7

### Patch Changes

- fix(langgraph): Handle wrapped LLM models in createReactAgent (RunnableSequence, withConfig, ...etc) by @dqbd in https://github.com/langchain-ai/langgraphjs/pull/1369
- fix(langgraph): avoid calling \_emit for runs without metadata by @dqbd in https://github.com/langchain-ai/langgraphjs/pull/1340
- fix(langgraph): fail fast when interrupt is called without checkpointer by @dqbd in https://github.com/langchain-ai/langgraphjs/pull/1343
- fix(langgraph): handle wrapped LLM models in createReactAgent by @dqbd in https://github.com/langchain-ai/langgraphjs/pull/1369
