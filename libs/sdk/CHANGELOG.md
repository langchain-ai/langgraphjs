# @langchain/langgraph-sdk

## 1.9.25

### Patch Changes

- [#2565](https://github.com/langchain-ai/langgraphjs/pull/2565) [`0558e47`](https://github.com/langchain-ai/langgraphjs/commit/0558e472b7697304c62cb6fe69cc3005e8e1a457) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): bundle pure-ESM deps into CJS build to fix ERR_REQUIRE_ESM

  Bundle the pure-ESM dependencies `p-retry` and `p-queue` (and their transitive ESM-only deps) into the build output so the CJS artifact no longer does a top-level `require()` of an ESM module. This fixes `ERR_REQUIRE_ESM` for CommonJS consumers on Node versions where `require(ESM)` is not enabled by default (< 20.19 / < 22.12). Closes [#2562](https://github.com/langchain-ai/langgraphjs/issues/2562).

## 1.9.24

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

## 1.9.23

### Patch Changes

- [#2545](https://github.com/langchain-ai/langgraphjs/pull/2545) [`2134c8a`](https://github.com/langchain-ai/langgraphjs/commit/2134c8a2c0bc8dd2ebea33e1191c8dd0c4b83236) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): avoid scoped stream resubscribe churn

  Defer final projection disposal by one microtask so framework bindings that release and immediately reacquire the same scoped projection during reactive updates keep the existing stream subscription instead of rotating through root-only and scoped SSE filters.

## 1.9.22

### Patch Changes

- [#2529](https://github.com/langchain-ai/langgraphjs/pull/2529) [`ba31f04`](https://github.com/langchain-ai/langgraphjs/commit/ba31f045d1d458a456c6f6441e8ee81d32c5c700) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): reconnect SSE streams when heartbeat idle is detected

  Detect half-open SSE connections by watching for server keep-alive heartbeats (`: heartbeat`) and reconnecting with Last-Event-ID or `since` when they stop. `"auto"` mode arms only after heartbeats are observed, so long tool calls and HITL pauses do not false-fire on heartbeat-emitting servers.

- [#2528](https://github.com/langchain-ai/langgraphjs/pull/2528) [`e7e8035`](https://github.com/langchain-ai/langgraphjs/commit/e7e8035fadca5f0d4cbc55bbbb77e65878ab2952) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Allow custom `AgentServerAdapter`s to be late-bound and re-bound to a thread. Adapters can now implement an optional `setThreadId(threadId)`, which `client.threads.stream(threadId, { transport })` calls when binding the active thread — including the lazily-minted id from the first `submit()` on a `threadId: null` controller. The built-in `ProtocolSseTransportAdapter`, `ProtocolWebSocketTransportAdapter`, and `HttpAgentServerAdapter` implement it: `threadId` is now optional at construction, request URLs derive from the currently-bound thread, and `paths` entries may be functions of the thread id (`(threadId) => string`). This lets a single custom transport back a lazy thread-creation flow instead of being pinned to one thread at construction.

- [#2527](https://github.com/langchain-ai/langgraphjs/pull/2527) [`9e114e5`](https://github.com/langchain-ai/langgraphjs/commit/9e114e55d362a874878a817740de42fd62ae9db7) Thanks [@christian-bromann](https://github.com/christian-bromann)! - chore(deps): remove uuid dependency in favor of embedded uuid in core

  Replace direct `uuid` package imports with `@langchain/core/utils/uuid` across
  langgraph packages to deduplicate dependencies and align with @langchain/core's
  embedded UUID utilities.

## 1.9.21

### Patch Changes

- [#2522](https://github.com/langchain-ai/langgraphjs/pull/2522) [`3855985`](https://github.com/langchain-ai/langgraphjs/commit/3855985dd049739f145295d236ce6aa02ae2fb0e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(stream): add per-event side-effect selector

  Add `useChannelEffect` (React/Svelte/Vue) / `injectChannelEffect` (Angular), a side-effect counterpart to `useChannel` that invokes an `onEvent` callback once per raw protocol event without re-rendering. This is the idiomatic v1 replacement for the old `onLangChainEvent` / `onCustomEvent` callbacks for analytics and logging. Backed by a new framework-agnostic `acquireChannelEffect` helper in `@langchain/langgraph-sdk/stream` that shares a ref-counted subscription with matching `useChannel` consumers.

- [#2523](https://github.com/langchain-ai/langgraphjs/pull/2523) [`7c3e9e9`](https://github.com/langchain-ai/langgraphjs/commit/7c3e9e93f3c7ec1dc654dac8ee8c03562ee8337b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): stop re-streaming seeded messages on idle-thread submit

  An idle (finished) thread defers its root SSE pump, so the first `submit()` brings it up and the transport replays the finished run from `seq=0`. The replayed `messages` channel carries no step (unlike `values`, guarded by `maxStep`), so it rebuilt each already-complete message from an empty `message-start` and re-streamed the whole turn token-by-token — a visible "messages replay" of the existing conversation. Seal the message ids seeded from the idle `getState()` snapshot so replayed deltas can't downgrade the complete tail; the seal lifts once a newer checkpoint advances the timeline or on thread rebind, and ids from the next run are never sealed.

- [#2462](https://github.com/langchain-ai/langgraphjs/pull/2462) [`17c44a3`](https://github.com/langchain-ai/langgraphjs/commit/17c44a38b7478e2bc4fe908a54c78ef33fb68ba3) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): reconnect v2 SSE and WebSocket thread streams after disconnect

  Add automatic reconnect with resume (`since` for SSE) for protocol transports,
  wire `AsyncCaller` through `client.threads.stream`, and expose optional
  reconnect tuning on `ThreadStreamOptions`. Includes integration tests against
  an in-process mock langgraph-api server.

## 1.9.20

### Patch Changes

- [#2508](https://github.com/langchain-ai/langgraphjs/pull/2508) [`41cd05a`](https://github.com/langchain-ai/langgraphjs/commit/41cd05a411ed262443c2bd1048e1b728b7331ac6) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): hydrate custom HttpAgentServerAdapter via transport getState

  StreamController now prefers adapter getState() before client.threads.getState,
  HttpAgentServerAdapter implements GET /threads/:id/state, and useStream inherits
  apiUrl from the transport so hydration no longer defaults to localhost:8123.

## 1.9.19

### Patch Changes

- [#2505](https://github.com/langchain-ai/langgraphjs/pull/2505) [`cad31b4`](https://github.com/langchain-ai/langgraphjs/commit/cad31b42f001a87fcdf57c4c084c655c8762b6a5) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Deduplicate the client stream transports: the protocol transport now shares the SSE decoder and `IterableReadableStream` helpers with the legacy transport instead of carrying its own copies. Removes the redundant `transport/decoder.ts` and `transport/stream.ts` shims (and a dead `StreamPart` re-export), importing the shared utilities from `utils/sse.ts` directly. No public API or behavior change.

## 1.9.18

### Patch Changes

- [#2500](https://github.com/langchain-ai/langgraphjs/pull/2500) [`f67772f`](https://github.com/langchain-ai/langgraphjs/commit/f67772ff3f7ac13d81576d395d7529de4eb4390b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): resume useChannel subscriptions across serial runs

  Enable `resumeOnPause` on the channel projection so `useChannel` keeps
  accumulating events across prompts on the same thread. Clarify selector
  docs and JSDoc: `useChannel` for the full event stream, `useExtension`
  for the latest payload.

## 1.9.17

### Patch Changes

- [#2494](https://github.com/langchain-ai/langgraphjs/pull/2494) [`0a0e04e`](https://github.com/langchain-ai/langgraphjs/commit/0a0e04e9ff7e82fd08411cc0094e1f94729a1e1e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): revive automatic optimistic submit echo

  Echo `submit()` input into `values` / `messages` immediately with client-side
  id minting and id-based reconciliation as the server streams back. Expose
  per-message `optimisticStatus` via message metadata (`pending` → `sent` /
  `failed`), shallow-merge non-message keys with rollback when no `values`
  arrive, and add an `optimistic: false` hook opt-out. Plumb through React,
  Vue, Svelte, and Angular with browser e2e coverage.

- [`658a076`](https://github.com/langchain-ai/langgraphjs/commit/658a076d5b50af9f5b96ab99f26ed629da6e182f) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): coalesce duplicate thread read requests

  Coalesce concurrent identical `threads.getState()` and `threads.getHistory()` reads within the SDK client so transient remounts do not issue duplicate hydrate requests. Request identity includes the prepared URL, body, method, and headers, and coalescing is skipped for caller-provided abort signals, raw response reads, and `onRequest` hooks to preserve auth and cancellation isolation.

- [#2497](https://github.com/langchain-ai/langgraphjs/pull/2497) [`a9aa8d6`](https://github.com/langchain-ai/langgraphjs/commit/a9aa8d6a9b23f5f7d4c56889fa68697b1e076b31) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): reconcile subagents and subgraphs on thread reconnect

  Seed deep-agent subagent cards from checkpoint messages and subgraph hosts from a single bounded `getHistory` read during `hydrate()`, so parallel fan-out discovery reappears immediately on refresh instead of waiting for SSE replay. Subagent execution namespaces are promoted through the existing guarded discovery state machine (bulk at hydrate, lazily per opened card via the selector layer). The getHistory cost is O(1) in requests regardless of fan-out width.

## 1.9.16

### Patch Changes

- [#2486](https://github.com/langchain-ai/langgraphjs/pull/2486) [`244c24e`](https://github.com/langchain-ai/langgraphjs/commit/244c24eaccff4009df7d83e4320e51a4b310b15f) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): surface resumed run failures on stream.error

  Route `respond()` and `respondAll()` through a coordinator dispatch path that
  writes the reactive `rootStore.error` slot when a resumed run reaches a failed
  terminal or when `input.respond` dispatch fails, matching submit() behavior so
  framework consumers (e.g. API-key retry UIs) observe resume failures via
  `stream.error` instead of only `isLoading` transitions.

## 1.9.15

### Patch Changes

- [#2484](https://github.com/langchain-ai/langgraphjs/pull/2484) [`9861f42`](https://github.com/langchain-ai/langgraphjs/commit/9861f42cc4fa23d9e80ae45a76d511d7618cda07) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): claim in-flight slot before root pump wait for enqueue

  Move `#runAbort` and `isLoading` setup ahead of `waitForRootPumpReady()` so
  `multitaskStrategy: "enqueue"` submits in the same tick land in `queueStore`
  instead of bypassing the client queue.

## 1.9.14

### Patch Changes

- [#2482](https://github.com/langchain-ai/langgraphjs/pull/2482) [`ba583b6`](https://github.com/langchain-ai/langgraphjs/commit/ba583b601d284c689bbfc15397686f1aa7481fba) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): keep subgraph status complete when values arrives late

  `SubgraphDiscovery` no longer downgrades a terminal subgraph back to
  `running` when a host-namespace `values` snapshot is observed after its
  `completed` or `failed` lifecycle event. The content pump and lifecycle
  watcher are independent streams, so this reordering could strand nodes as
  perpetually running in `useStream` subgraph UIs.

## 1.9.13

### Patch Changes

- [#2469](https://github.com/langchain-ai/langgraphjs/pull/2469) [`0bbe66e`](https://github.com/langchain-ai/langgraphjs/commit/0bbe66e31de3abe7526c7810755a40c31bc60e0d) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): normalize HITL edit decisions for Python servers

  `StreamController.respond()` now mirrors camelCase and snake_case on edit
  decisions (`editedAction` / `edited_action`) so JS clients can resume
  human-in-the-loop interrupts against Python LangGraph servers.

## 1.9.12

### Patch Changes

- [#2467](https://github.com/langchain-ai/langgraphjs/pull/2467) [`0491534`](https://github.com/langchain-ai/langgraphjs/commit/04915347128e40fc9617647cadba6b472a357d36) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): route headless tool resumes through respond on v1 stream

  `useStream` was calling `submit(null, { command })` for headless-tool resumes,
  which dispatches `run.start` without delivering the tool result. Add
  `applyHeadlessToolResumeCommand` to route payloads through `respond` /
  `respondAll`, and tighten headless-tool browser tests to assert end-to-end
  resume and graph completion.

## 1.9.11

### Patch Changes

- [#2455](https://github.com/langchain-ai/langgraphjs/pull/2455) [`863b555`](https://github.com/langchain-ai/langgraphjs/commit/863b555346de02c2c0be290e877b7d260a3f8856) Thanks [@JHSeo-git](https://github.com/JHSeo-git)! - fix(sdk): prefer completed task's direct mapping over pending checkpoint's positional guess in fetchSubagentHistory

- [#2344](https://github.com/langchain-ai/langgraphjs/pull/2344) [`0125920`](https://github.com/langchain-ai/langgraphjs/commit/0125920a2c4a87dc1d66aaf541ea16146f8cf842) Thanks [@dependabot](https://github.com/apps/dependabot)! - chore(deps): bump uuid to 14.0.0 and keep checkpoint ID ordering stable

  Bump `uuid` from 10.x/13.x to 14.0.0 across packages. Starting with uuid 11, `v6({ clockseq })` no longer advances the sub-millisecond time counter when an explicit `clockseq` is passed, so checkpoint IDs created within the same millisecond were ordered only by `clockseq`. Since checkpoint IDs are sorted lexicographically, this broke ordering — most visibly for the negative `clockseq` used by the first ("input") checkpoint, which sorted as the newest.

  `uuid6()` now maintains its own monotonic `(msecs, nsecs)` clock (mirroring uuid 10's internal v1 behavior) so the time component is always strictly increasing and checkpoint ordering no longer depends on the `clockseq` value. `emptyCheckpoint()` also uses a non-negative `clockseq`.

## 1.9.10

### Patch Changes

- [#2447](https://github.com/langchain-ai/langgraphjs/pull/2447) [`80c2806`](https://github.com/langchain-ai/langgraphjs/commit/80c2806cb2da93745a640664bd0cf603c2361da9) Thanks [@christian-bromann](https://github.com/christian-bromann)! - protocol-v2: fold forkFrom client-side and honor per-run multitaskStrategy

  The SDK now folds the ergonomic `forkFrom` option into
  `config.configurable.checkpoint_id` before sending `run.start`, so the
  agent server only ever accepts the single, legacy-compliant fork field
  (`forkFrom` no longer hits the wire). The protocol-v2 reference servers
  drop their top-level `forkFrom` normalization accordingly.

  The protocol-v2 servers now honor the caller's `multitaskStrategy` per
  run (one of `reject` | `rollback` | `interrupt` | `enqueue`) instead of
  hardcoding it, falling back to `enqueue` when omitted or unrecognized.

- [#2443](https://github.com/langchain-ai/langgraphjs/pull/2443) [`80a8c12`](https://github.com/langchain-ai/langgraphjs/commit/80a8c1200a240fd984edc4deb26a7787d08c7532) Thanks [@christian-bromann](https://github.com/christian-bromann)! - refactor(sdk): drop StreamSubmitOptions.command and simplify forkFrom

  Remove the misleading submit({ command }) surface from protocol-v2
  StreamController; HITL resume is respond() only. Accept forkFrom as a
  plain checkpoint id string and align protocol-v2 servers and docs.

- [#2448](https://github.com/langchain-ai/langgraphjs/pull/2448) [`2c14b12`](https://github.com/langchain-ai/langgraphjs/commit/2c14b12a80c306578563e77595943037c7c4844d) Thanks [@christian-bromann](https://github.com/christian-bromann)! - protocol-v2: add `respondAll()` and run config/metadata on interrupt resume

  The stream controller (and the React/Angular/Svelte/Vue wrappers) gain a
  `respondAll(responsesById, options)` method to resume several interrupts
  pending at the same checkpoint in a single command — required for runs that
  pause on multiple interrupts at once (e.g. parallel tool-authorization
  prompts), which sequential `respond()` calls cannot handle.

  `respond()` now takes an options object (`{ interruptId?, namespace?,
config?, metadata? }`) so a resumed run can carry the same run-level config
  (model, user context, …) and metadata (trigger source, test flags, …) a
  fresh `submit()` would. The protocol-v2 reference servers read the new
  `responses` batch and `config` / `metadata` fields leniently and fold them
  onto the run that services the `input.respond` command.

## 1.9.9

### Patch Changes

- [#2441](https://github.com/langchain-ai/langgraphjs/pull/2441) [`dbbcb63`](https://github.com/langchain-ai/langgraphjs/commit/dbbcb636e742c38e89854a8ae7ef4e1566d44343) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): preserve apiUrl path prefix in stream transport URLs

  Use BaseClient-style URL concatenation in `toAbsoluteUrl` so SSE and WebSocket
  subscriptions work when the SDK is pointed at a proxied apiUrl with a path
  prefix (e.g. `/api/chat-langchain`).

## 1.9.8

### Patch Changes

- [#2438](https://github.com/langchain-ai/langgraphjs/pull/2438) [`29d2bde`](https://github.com/langchain-ai/langgraphjs/commit/29d2bde235bf85e8a5e1dd59a997266ff894484b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): cancel runs on stop by default and add disconnect()

  `stream.stop()` now calls `client.runs.cancel` for the active run before disconnecting the client (default `{ cancel: true }`). Join/rejoin UIs can call `stream.disconnect()` or `stop({ cancel: false })` to leave the agent running server-side.

  This fills a missing gap we found when migrating to v1.

## 1.9.7

### Patch Changes

- [#2435](https://github.com/langchain-ai/langgraphjs/pull/2435) [`cfc8d27`](https://github.com/langchain-ai/langgraphjs/commit/cfc8d274e4dc99cb73ebd9abc4f971622105f08e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): unwrap Command tool outputs and hide scoped task tools

  Filter wrapper `task` dispatch events from subagent-scoped tool-call
  projections and parse embedded ToolMessage results from LangGraph
  `Command` payloads on `tool-finished`.

- [#2434](https://github.com/langchain-ai/langgraphjs/pull/2434) [`6b188e8`](https://github.com/langchain-ai/langgraphjs/commit/6b188e80ab989fc8396e1926f729d93b786ca671) Thanks [@hntrl](https://github.com/hntrl)! - fix(react): avoid eager stream getter evaluation during object spread

  Mark optional `useStream` accessors as non-enumerable so object spread/rest destructuring does not accidentally read guarded fields like `history` or opt into additional stream modes.

## 1.9.6

### Patch Changes

- [#2430](https://github.com/langchain-ai/langgraphjs/pull/2430) [`f99941f`](https://github.com/langchain-ai/langgraphjs/commit/f99941f5fe8671ddcb6a78e93e5e05f4028d4af4) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): clear subgraph and subagent discovery on thread swap

  Reset discovery stores in `StreamController.#teardownThread()` so starting a
  new thread does not leave stale subgraph cards or subagent entries from the
  previous run.

## 1.9.5

### Patch Changes

- [#2421](https://github.com/langchain-ai/langgraphjs/pull/2421) [`3529e38`](https://github.com/langchain-ai/langgraphjs/commit/3529e3831a488134e7dfaefa4ed7fb1140cf8bb6) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(stream): align AssembledToolCall typing with pre-v1 expectations

  Make `InferToolCalls` resolve to generic `AssembledToolCall` unions, expose
  sync `status`/`error` for reactive bindings, and align type tests across
  React, Vue, Svelte, and Angular SDK packages.

## 1.9.4

### Patch Changes

- [#2415](https://github.com/langchain-ai/langgraphjs/pull/2415) [`9d3c9dd`](https://github.com/langchain-ai/langgraphjs/commit/9d3c9dd3182059f9eca9fd9b14d8f7466b4338c4) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Move `@langchain/core` from a runtime dependency back to a required peer dependency so installing the SDK alone no longer pulls in `@langchain/core` (and `js-tiktoken`, etc.). Consumers that use streaming or message coercion must install `@langchain/core` explicitly or via `@langchain/langgraph`.

## 1.9.3

### Patch Changes

- [#2387](https://github.com/langchain-ai/langgraphjs/pull/2387) [`44746b1`](https://github.com/langchain-ai/langgraphjs/commit/44746b1a3b5b49737542b120b9e45d6f94181113) Thanks [@nick-hollon-lc](https://github.com/nick-hollon-lc)! - Coalesce `RootMessageProjection` store writes through a single `setTimeout(0)` flush so long `messages`-channel replays (on refresh, mid-run join, or rapid subagent streaming) no longer drain as a per-event microtask chain that trips React's `Maximum update depth exceeded` guard. Replaces the previous `MessageChannel`-based batching, which deferred initial-submit events past the first render and left the UI looking frozen until refresh.

- [#2372](https://github.com/langchain-ai/langgraphjs/pull/2372) [`4cc6491`](https://github.com/langchain-ai/langgraphjs/commit/4cc6491844f21ed0fc737eaef8498133daa877f7) Thanks [@ahmed-z0](https://github.com/ahmed-z0)! - Fix subagent message routing to prefer the stream event namespace over checkpoint metadata when filtering subagent messages.

- [#2384](https://github.com/langchain-ai/langgraphjs/pull/2384) [`ae8af2d`](https://github.com/langchain-ai/langgraphjs/commit/ae8af2d75aef9a7bbd930d221d1ce03e7fbb90ad) Thanks [@nick-hollon-lc](https://github.com/nick-hollon-lc)! - batch RootMessageProjection store writes through a macrotask

- [#2388](https://github.com/langchain-ai/langgraphjs/pull/2388) [`01dd046`](https://github.com/langchain-ai/langgraphjs/commit/01dd0462ed300dee5a9a51f229e6c401315f070c) Thanks [@hntrl](https://github.com/hntrl)! - fix(sdk): retry connection failures before throwing ConnectionError

- [#2381](https://github.com/langchain-ai/langgraphjs/pull/2381) [`2ad1aa4`](https://github.com/langchain-ai/langgraphjs/commit/2ad1aa48c6a3f45340b4833e6de555fdc7348d15) Thanks [@nick-hollon-lc](https://github.com/nick-hollon-lc)! - fix(sdk): forward config + metadata on respondInput for resume submits

- [#2379](https://github.com/langchain-ai/langgraphjs/pull/2379) [`75e651b`](https://github.com/langchain-ai/langgraphjs/commit/75e651b9cff1a1e39ad6513b8a5e9b565b9ad7fe) Thanks [@nick-hollon-lc](https://github.com/nick-hollon-lc)! - filter SSE-replayed input.requested events through a hydrated interrupt allowlist

- [#2390](https://github.com/langchain-ai/langgraphjs/pull/2390) [`f1d651a`](https://github.com/langchain-ai/langgraphjs/commit/f1d651ae14ca178f4a915ac853ba9b439cd55ba3) Thanks [@nick-hollon-lc](https://github.com/nick-hollon-lc)! - Bind deepagents subagent discovery to the execution namespace via taskInput so `useMessages(stream, subagent)` resolves the streaming scope instead of the trigger tool-call namespace.

## 1.9.3-rc.0

### Patch Changes

- [#2387](https://github.com/langchain-ai/langgraphjs/pull/2387) [`44746b1`](https://github.com/langchain-ai/langgraphjs/commit/44746b1a3b5b49737542b120b9e45d6f94181113) Thanks [@nick-hollon-lc](https://github.com/nick-hollon-lc)! - Coalesce `RootMessageProjection` store writes through a single `setTimeout(0)` flush so long `messages`-channel replays (on refresh, mid-run join, or rapid subagent streaming) no longer drain as a per-event microtask chain that trips React's `Maximum update depth exceeded` guard. Replaces the previous `MessageChannel`-based batching, which deferred initial-submit events past the first render and left the UI looking frozen until refresh.

- [#2372](https://github.com/langchain-ai/langgraphjs/pull/2372) [`4cc6491`](https://github.com/langchain-ai/langgraphjs/commit/4cc6491844f21ed0fc737eaef8498133daa877f7) Thanks [@ahmed-z0](https://github.com/ahmed-z0)! - Fix subagent message routing to prefer the stream event namespace over checkpoint metadata when filtering subagent messages.

- [#2384](https://github.com/langchain-ai/langgraphjs/pull/2384) [`ae8af2d`](https://github.com/langchain-ai/langgraphjs/commit/ae8af2d75aef9a7bbd930d221d1ce03e7fbb90ad) Thanks [@nick-hollon-lc](https://github.com/nick-hollon-lc)! - batch RootMessageProjection store writes through a macrotask

- [#2381](https://github.com/langchain-ai/langgraphjs/pull/2381) [`2ad1aa4`](https://github.com/langchain-ai/langgraphjs/commit/2ad1aa48c6a3f45340b4833e6de555fdc7348d15) Thanks [@nick-hollon-lc](https://github.com/nick-hollon-lc)! - fix(sdk): forward config + metadata on respondInput for resume submits

- [#2379](https://github.com/langchain-ai/langgraphjs/pull/2379) [`75e651b`](https://github.com/langchain-ai/langgraphjs/commit/75e651b9cff1a1e39ad6513b8a5e9b565b9ad7fe) Thanks [@nick-hollon-lc](https://github.com/nick-hollon-lc)! - filter SSE-replayed input.requested events through a hydrated interrupt allowlist

- [#2390](https://github.com/langchain-ai/langgraphjs/pull/2390) [`f1d651a`](https://github.com/langchain-ai/langgraphjs/commit/f1d651ae14ca178f4a915ac853ba9b439cd55ba3) Thanks [@nick-hollon-lc](https://github.com/nick-hollon-lc)! - Bind deepagents subagent discovery to the execution namespace via taskInput so `useMessages(stream, subagent)` resolves the streaming scope instead of the trigger tool-call namespace.

## 1.9.2

### Patch Changes

- [#2370](https://github.com/langchain-ai/langgraphjs/pull/2370) [`4c6875c`](https://github.com/langchain-ai/langgraphjs/commit/4c6875c1e3dd32857d526925865c389e4e9c10c2) Thanks [@open-swe](https://github.com/apps/open-swe)! - feat(sdk): support metadata filter for crons search/count

- [#2377](https://github.com/langchain-ai/langgraphjs/pull/2377) [`a5089cd`](https://github.com/langchain-ai/langgraphjs/commit/a5089cda1d9db1e4b50c17cdd12a770a67279905) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): preserve AI content blocks during message projection

## 1.9.1

### Patch Changes

- [#2366](https://github.com/langchain-ai/langgraphjs/pull/2366) [`2bb66bf`](https://github.com/langchain-ai/langgraphjs/commit/2bb66bf816a8b18b2968ed885ef2df15f684cb4e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): update endpoints

## 1.9.0

### Minor Changes

- [#2314](https://github.com/langchain-ai/langgraphjs/pull/2314) [`085a07f`](https://github.com/langchain-ai/langgraphjs/commit/085a07f569b6d7d79728eb7eb6eb3a0c67fcdefb) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Add the framework-agnostic event streaming SDK.

  The SDK now includes a thread-focused streaming client built around
  `ThreadStream`, `SubscriptionHandle`, message assembly, media assembly, typed
  stream extensions, and pluggable protocol transports. Applications can stream
  over SSE or WebSocket, provide custom agent-server adapters, subscribe to
  values/messages/tools/custom/lifecycle/checkpoint channels, inspect and fork
  state, respond to interrupts, and replay or dedupe ordered event streams.

  This release also adds the reusable stream runtime used by the React, Vue,
  Svelte, and Angular packages: `StreamController`, `StreamStore`,
  `ChannelRegistry`, projection factories, subagent/subgraph discovery,
  submission queue coordination, message metadata tracking, root message
  projection, media projections, and helper types for agent/deep-agent state and
  tool-call inference.

  The client package has been reorganized into focused modules for assistants,
  threads, runs, store, protocol streaming, transports, media, messages, and UI
  helpers. New SDK documentation covers configuration, assistants, threads, runs,
  store, streaming, transports, extensions, interrupts, messages, media,
  subagents, and subgraphs.

### Patch Changes

- [#2363](https://github.com/langchain-ai/langgraphjs/pull/2363) [`d1e2fda`](https://github.com/langchain-ai/langgraphjs/commit/d1e2fda1b1165e122362780a62ab8d2ebff9f9b9) Thanks [@cwlbraa](https://github.com/cwlbraa)! - Add a `returnMinimal` option to `threads.update`.

## 1.8.10

### Patch Changes

- [#2340](https://github.com/langchain-ai/langgraphjs/pull/2340) [`6bab458`](https://github.com/langchain-ai/langgraphjs/commit/6bab458d4a03ce2d7b2708488b92226899eb94d4) Thanks [@cwlbraa](https://github.com/cwlbraa)! - Respect `fetchStateHistory` when restoring subagent history.

## 1.8.9

### Patch Changes

- [#2302](https://github.com/langchain-ai/langgraphjs/pull/2302) [`458d66b`](https://github.com/langchain-ai/langgraphjs/commit/458d66bf665468854abb8133594d4d4f966054ed) Thanks [@AdrianSajjan](https://github.com/AdrianSajjan)! - fix(sdk): preserve messages on interrupt values events

  Add a regression test for interrupt-only `values` payloads to ensure
  previously streamed messages are not overwritten when `__interrupt__` is emitted.

## 1.8.8

### Patch Changes

- [#2292](https://github.com/langchain-ai/langgraphjs/pull/2292) [`33293c7`](https://github.com/langchain-ai/langgraphjs/commit/33293c7f3f110bb462d77a2f8671e5b9d0e84b63) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): buffer subagent messages instead of dropping them

## 1.8.7

### Patch Changes

- [#2285](https://github.com/langchain-ai/langgraphjs/pull/2285) [`a5dfdb6`](https://github.com/langchain-ai/langgraphjs/commit/a5dfdb61c7af0b957b0064b02cb390a11cd59b56) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): detect interrupt for Python agents

## 1.8.6

### Patch Changes

- [`b4a841c`](https://github.com/langchain-ai/langgraphjs/commit/b4a841c4b369db7f0fa93fe1de6b3b1ac3e8d3fb) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): bump all packages

## 1.8.5

### Patch Changes

- [#2279](https://github.com/langchain-ai/langgraphjs/pull/2279) [`3bbb3ff`](https://github.com/langchain-ai/langgraphjs/commit/3bbb3ff65aa3c1de96c7d751c14dc9ee11e3b095) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): better type inferrence

- [#2278](https://github.com/langchain-ai/langgraphjs/pull/2278) [`0d04099`](https://github.com/langchain-ai/langgraphjs/commit/0d04099958dcca0a1ed053e6a41cc2c12bab78f5) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(vue): Make subagents accessible once they are spun up

## 1.8.4

### Patch Changes

- [#2263](https://github.com/langchain-ai/langgraphjs/pull/2263) [`936b48b`](https://github.com/langchain-ai/langgraphjs/commit/936b48b2807687d3fa5dd7aa480ebcc2ad3ffccf) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Restore deprecated snake_case aliases on human-in-the-loop interrupt payloads
  while preserving the newer camelCase fields so older apps can migrate to
  `@langchain/react` without breaking interrupt handling.

## 1.8.3

### Patch Changes

- [#2204](https://github.com/langchain-ai/langgraphjs/pull/2204) [`d9d807e`](https://github.com/langchain-ai/langgraphjs/commit/d9d807ebb0398a43a07412fb034a65fc598c0731) Thanks [@brydar](https://github.com/brydar)! - fix(sdk): accumulate parallel interrupts in StreamManager

## 1.8.2

### Patch Changes

- [#2250](https://github.com/langchain-ai/langgraphjs/pull/2250) [`8eaf410`](https://github.com/langchain-ai/langgraphjs/commit/8eaf41069264753947e5c9633b567e589dc0e532) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): skip post-stream getHistory for zero-arity onFinish

## 1.8.1

### Patch Changes

- [#2237](https://github.com/langchain-ai/langgraphjs/pull/2237) [`88726df`](https://github.com/langchain-ai/langgraphjs/commit/88726dfe222aed64e5cd5dfa6f77f886b5a0d205) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Extract shared `WithClassMessages<T>` type to `@langchain/langgraph-sdk/ui`

- [#2243](https://github.com/langchain-ai/langgraphjs/pull/2243) [`7dfcbff`](https://github.com/langchain-ai/langgraphjs/commit/7dfcbffd4805b2b4cc41f07f30be57ed732786b4) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(skd): normalize interrupts between JS and Python

## 1.8.0

### Minor Changes

- [#2227](https://github.com/langchain-ai/langgraphjs/pull/2227) [`414a7ad`](https://github.com/langchain-ai/langgraphjs/commit/414a7adf908ba4f7ffef4985df3a95f14202591b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat: extract shared orchestrator to eliminate duplicated code across SDK packages

## 1.7.5

### Patch Changes

- [`fe4dd5b`](https://github.com/langchain-ai/langgraphjs/commit/fe4dd5b85d285f78b6d499b1f1013927931ea634) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Support `onFinish` callback in custom transport, ensuring it is called when the stream completes.

- [`fe4dd5b`](https://github.com/langchain-ai/langgraphjs/commit/fe4dd5b85d285f78b6d499b1f1013927931ea634) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): fetch subagent history

- [`fe4dd5b`](https://github.com/langchain-ai/langgraphjs/commit/fe4dd5b85d285f78b6d499b1f1013927931ea634) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Forward streamSubgraphs in custom transports

## 1.7.4

### Patch Changes

- [#2200](https://github.com/langchain-ai/langgraphjs/pull/2200) [`3873f36`](https://github.com/langchain-ai/langgraphjs/commit/3873f36c42e4fb1a2cd797a02e37875b16455cfe) Thanks [@hntrl](https://github.com/hntrl)! - Add checkpointId support to threads.updateState, runs.create, and runs.wait methods

## 1.7.3

### Patch Changes

- [#2189](https://github.com/langchain-ai/langgraphjs/pull/2189) [`8fec72a`](https://github.com/langchain-ai/langgraphjs/commit/8fec72ae98b117b79048403d0f7ad75d653c090b) Thanks [@pawel-twardziak](https://github.com/pawel-twardziak)! - Fix `getSubagentsByMessage` returning empty array for OpenAI models by updating `aiMessageId` when the provider replaces it during streaming.

- [#2170](https://github.com/langchain-ai/langgraphjs/pull/2170) [`a9ff2ef`](https://github.com/langchain-ai/langgraphjs/commit/a9ff2efdf0a2b6ff0301eedfff541e125c1e6300) Thanks [@jdrogers940](https://github.com/jdrogers940)! - add cancelMany method to sdk

- [#2173](https://github.com/langchain-ai/langgraphjs/pull/2173) [`a24bb55`](https://github.com/langchain-ai/langgraphjs/commit/a24bb550fb81271c505b9cab0295d8e599aaeb79) Thanks [@hinthornw](https://github.com/hinthornw)! - Adds threads.prune and updates SDK methods to have latest values.

- [#2177](https://github.com/langchain-ai/langgraphjs/pull/2177) [`b80076c`](https://github.com/langchain-ai/langgraphjs/commit/b80076c5a7fc1b6985abc1fd9c367438ba6ca968) Thanks [@hntrl](https://github.com/hntrl)! - handle null values in functional graph checkpoint history

## 1.7.2

### Patch Changes

- [#2168](https://github.com/langchain-ai/langgraphjs/pull/2168) [`98da019`](https://github.com/langchain-ai/langgraphjs/commit/98da019c926c684c01fe7b598cad57cf6f929268) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): revert dependency between old SDK and new react package

## 1.7.1

### Patch Changes

- [#2014](https://github.com/langchain-ai/langgraphjs/pull/2014) [`745112c`](https://github.com/langchain-ai/langgraphjs/commit/745112c0d754d0403aab415f46550dd61474dbd9) Thanks [@TheComputerM](https://github.com/TheComputerM)! - fix: use optimistic threadId in a custom stream

- [#2165](https://github.com/langchain-ai/langgraphjs/pull/2165) [`8faf05c`](https://github.com/langchain-ai/langgraphjs/commit/8faf05c939051effda4d3566d2f24a0a96ae7a56) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(sdk): convert history messages to BaseMessage instances in framework SDKs

  When accessing `stream.history` in the framework SDK packages (React,
  Svelte, Angular, Vue), messages within thread state values are now
  converted to proper @langchain/core BaseMessage class instances (e.g.
  HumanMessage, AIMessage) instead of being returned as plain objects.

  The base `@langchain/langgraph-sdk` package is intentionally unchanged
  and continues to return plain Message dicts for backward compatibility.

  - Add `ensureHistoryMessageInstances` utility to convert messages within
    ThreadState values to BaseMessage instances
  - Add `HistoryWithBaseMessages` type utility so `state.values.messages`
    is typed as `BaseMessage[]` in framework SDK history
  - Update `WithClassMessages` in all four framework SDKs to remap the
    `history` property type accordingly
  - Add unit tests (messages.test.ts) and type tests (stream-types.test-d.ts)
    in the base SDK verifying plain Message behavior is preserved
  - Add integration tests and type tests in all four framework SDKs
    verifying BaseMessage conversion

## 1.7.0

### Minor Changes

- [#2001](https://github.com/langchain-ai/langgraphjs/pull/2001) [`e051ef6`](https://github.com/langchain-ai/langgraphjs/commit/e051ef6aa8301f39badc9f496cbacef73bb4e2c4) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(react): initial first release for `@langchain/react`

## 1.6.5

### Patch Changes

- [#1984](https://github.com/langchain-ai/langgraphjs/pull/1984) [`aa8e878`](https://github.com/langchain-ai/langgraphjs/commit/aa8e878e5b71128685ab7e7a79c96bd2519c0123) Thanks [@colifran](https://github.com/colifran)! - feat: add tools stream mode for tool lifecycle events

- [#1987](https://github.com/langchain-ai/langgraphjs/pull/1987) [`1b088e5`](https://github.com/langchain-ai/langgraphjs/commit/1b088e578aaef7d231f37885b94bfd763f99a775) Thanks [@hinthornw](https://github.com/hinthornw)! - feat(sdk): add extract parameter to threads.search()

## 1.6.4

### Patch Changes

- [#1958](https://github.com/langchain-ai/langgraphjs/pull/1958) [`fc6505b`](https://github.com/langchain-ai/langgraphjs/commit/fc6505b5c380713ac769786825613f5c68ac9ea8) Thanks [@hieusmiths](https://github.com/hieusmiths)! - Export stream error class

- [#1978](https://github.com/langchain-ai/langgraphjs/pull/1978) [`d7828d0`](https://github.com/langchain-ai/langgraphjs/commit/d7828d0e1a8a05e703bf9783037b8b97a475ff10) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): resolve UseStream type incompatibility with useStream return type

- [#1977](https://github.com/langchain-ai/langgraphjs/pull/1977) [`33eb707`](https://github.com/langchain-ai/langgraphjs/commit/33eb70747b0446f109a445d14d8cfcdd8a14a93c) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): abort previous stream in useStream when using interrupt/rollback multitask strategy

## 1.6.3

### Patch Changes

- [#1972](https://github.com/langchain-ai/langgraphjs/pull/1972) [`242cfbb`](https://github.com/langchain-ai/langgraphjs/commit/242cfbbb6ab375c91bd021f64ec652840af591a9) Thanks [@rx5ad](https://github.com/rx5ad)! - add 'state_updated_at' field to threads

## 1.6.2

### Patch Changes

- [#1956](https://github.com/langchain-ai/langgraphjs/pull/1956) [`8a84c04`](https://github.com/langchain-ai/langgraphjs/commit/8a84c0448eb2db7619c43be7c6e35daa058ac613) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): make SubagentStream and SubagentToolCall generic for type-safe subagent inference

## 1.6.1

### Patch Changes

- [#1951](https://github.com/langchain-ai/langgraphjs/pull/1951) [`948aa2d`](https://github.com/langchain-ai/langgraphjs/commit/948aa2d8617398dc797e67b3f152ac6f8d7bdfd3) Thanks [@maahir30](https://github.com/maahir30)! - feat(stream): Add interrupts array to useStream for multi-interrupt support
  - Adds a new interrupts (plural) array property to the useStream hook

## 1.6.0

### Minor Changes

- [#1903](https://github.com/langchain-ai/langgraphjs/pull/1903) [`8d5c2d6`](https://github.com/langchain-ai/langgraphjs/commit/8d5c2d688d330012638d8f34ce20a454600ebc1b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(sdk): add multi-subagent tracking to useStream

## 1.5.6

### Patch Changes

- [#1940](https://github.com/langchain-ai/langgraphjs/pull/1940) [`d23a4db`](https://github.com/langchain-ai/langgraphjs/commit/d23a4dbcb98d0247869dcb876022d680f9c328c4) Thanks [@rx5ad](https://github.com/rx5ad)! - feat(sdk-js): add support for pausing/unpausing crons

## 1.5.5

### Patch Changes

- [#1893](https://github.com/langchain-ai/langgraphjs/pull/1893) [`98c0f26`](https://github.com/langchain-ai/langgraphjs/commit/98c0f26f4cc2c246359914704278ff5e3ae46a01) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): infer agent types in stream.values

- [#1909](https://github.com/langchain-ai/langgraphjs/pull/1909) [`a3669be`](https://github.com/langchain-ai/langgraphjs/commit/a3669be176c5bca4b5bbcc6a6245882a684fb12f) Thanks [@dqbd](https://github.com/dqbd)! - Make sure we always pass URL as a string to fetch

## 1.5.4

### Patch Changes

- [#1821](https://github.com/langchain-ai/langgraphjs/pull/1821) [`5629d46`](https://github.com/langchain-ai/langgraphjs/commit/5629d46362509f506ab455389e600eff7d9b34bb) Thanks [@dqbd](https://github.com/dqbd)! - feat(sdk): allow client-side filtering of events when joining a stream.

- [#1897](https://github.com/langchain-ai/langgraphjs/pull/1897) [`78743d6`](https://github.com/langchain-ai/langgraphjs/commit/78743d6bca96945d574713ffefe32b04a4c04d29) Thanks [@bracesproul](https://github.com/bracesproul)! - fix: cannot convert undefined or null to object error in `useStream`

## 1.5.3

### Patch Changes

- [#1887](https://github.com/langchain-ai/langgraphjs/pull/1887) [`2eef6ed`](https://github.com/langchain-ai/langgraphjs/commit/2eef6ed3a584694c0d1c567ff6db8a70616de776) Thanks [@hinthornw](https://github.com/hinthornw)! - Made JS SSE reconnect logic match Python by retrying based on Location (even before a first event) and retry on Undici connection errors.

## 1.5.2

### Patch Changes

- [#1882](https://github.com/langchain-ai/langgraphjs/pull/1882) [`f2e24a0`](https://github.com/langchain-ai/langgraphjs/commit/f2e24a038721a378d11275cd3201948defb7f36a) Thanks [@andrewnguonly](https://github.com/andrewnguonly)! - Fix bug in UseStream export.

## 1.5.1

### Patch Changes

- [#1880](https://github.com/langchain-ai/langgraphjs/pull/1880) [`7ec00d8`](https://github.com/langchain-ai/langgraphjs/commit/7ec00d8012ea4fb7132f009ba57992eecdce1ae5) Thanks [@hntrl](https://github.com/hntrl)! - readd UseStream instance exports

## 1.5.0

### Minor Changes

- [#1845](https://github.com/langchain-ai/langgraphjs/pull/1845) [`344b2d2`](https://github.com/langchain-ai/langgraphjs/commit/344b2d2c1a6dca43e9b01e436b00bca393bc9538) Thanks [@cwlbraa](https://github.com/cwlbraa)! - Add `onRunCompleted` parameter to `CronsClient.create()` for controlling thread cleanup behavior in stateless crons. Options are `"delete"` (default) to automatically clean up threads, or `"keep"` to preserve threads for later retrieval.

### Patch Changes

- [#1874](https://github.com/langchain-ai/langgraphjs/pull/1874) [`84a636e`](https://github.com/langchain-ai/langgraphjs/commit/84a636e52f7d3a4b97ae69d050efd9ca0224c6ca) Thanks [@bracesproul](https://github.com/bracesproul)! - Expose and pass down interrupt generic type

- [#1873](https://github.com/langchain-ai/langgraphjs/pull/1873) [`2b9f3ee`](https://github.com/langchain-ai/langgraphjs/commit/2b9f3ee83d0b8ba023e7a52b938260af3f6433d4) Thanks [@andrewnguonly](https://github.com/andrewnguonly)! - Add delete_threads query parameter to delete assistants API.

## 1.4.6

### Patch Changes

- [#1862](https://github.com/langchain-ai/langgraphjs/pull/1862) [`e7aeffe`](https://github.com/langchain-ai/langgraphjs/commit/e7aeffeb72aaccd8c94f8e78708f747ce21bf23c) Thanks [@dqbd](https://github.com/dqbd)! - retry release: add type-safe tool call streaming with agent type inference, provide proper error message when failing to connect to a server, expose Thread["config"] and Thread["error"]

## 1.4.5

### Patch Changes

- [#1856](https://github.com/langchain-ai/langgraphjs/pull/1856) [`a9fa28b`](https://github.com/langchain-ai/langgraphjs/commit/a9fa28b6adad16050fcf5d5876a3924253664217) Thanks [@christian-bromann](https://github.com/christian-bromann)! - retry release: add type-safe tool call streaming with agent type inference, provide proper error message when failing to connect to a server, expose Thread["config"] and Thread["error"]

## 1.4.4

### Patch Changes

- [#1853](https://github.com/langchain-ai/langgraphjs/pull/1853) [`a84c1ff`](https://github.com/langchain-ai/langgraphjs/commit/a84c1ff18289653ff4715bd0db4ac3d06600556e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - retry release: add type-safe tool call streaming with agent type inference, provide proper error message when failing to connect to a server, expose Thread["config"] and Thread["error"]

## 1.4.3

### Patch Changes

- [#1850](https://github.com/langchain-ai/langgraphjs/pull/1850) [`e9f7e8e`](https://github.com/langchain-ai/langgraphjs/commit/e9f7e8e9e6b8851cb7dd68e31d2f1867b62bd6bd) Thanks [@christian-bromann](https://github.com/christian-bromann)! - retry release: add type-safe tool call streaming with agent type inference, provide proper error message when failing to connect to a server, expose Thread["config"] and Thread["error"]

## 1.4.2

### Patch Changes

- 3ec85a4: retry release: add type-safe tool call streaming with agent type inference, provide proper error message when failing to connect to a server, expose Thread["config"] and Thread["error"]

## 1.4.1

### Patch Changes

- 3613386: retry release: add type-safe tool call streaming with agent type inference, provide proper error message when failing to connect to a server, expose Thread["config"] and Thread["error"]

## 1.4.0

### Minor Changes

- 730dc7c: feat(sdk): add type-safe tool call streaming with agent type inference

### Patch Changes

- 730dc7c: fix(sdk): provide proper error message when failing to connect to a server
- 4ffdde9: Expose `Thread["config"]` and `Thread["error"]`

## 1.3.1

### Patch Changes

- 58aa2cf: Adding retry support for stream methods on network issues

## 1.3.0

### Minor Changes

- 1497df9: feat(sdk): add support for enqueuing `useStream().submit(...)` calls while the agent is still running

## 1.2.0

### Minor Changes

- 379de5e: Fix tool calls arguments not being streamed to the client

### Patch Changes

- d08e484: Add support for sending `AbortSignal` to all SDK methods
- d08e484: Fix `useStream().stop()` not cancelling creation of thread.

## 1.1.0

### Minor Changes

- e19e76c: Rename `experimental_thread` to `thread`, allowing replacing built-in history fetching hook with React Query / SWR
- fa6c009: Add throttle option to `useStream` and batch updates in a macrotask to prevent `Maximum update depth exceeded` error

### Patch Changes

- 35e8fc7: Add name parameter to assistants count API.
- b78a738: feat(sdk): add `includePagination` property when searching from assistants

## 1.0.3

### Patch Changes

- 5ae7552: Adding support to skip auto loading api key when set to null on sdk client create

## 1.0.2

### Patch Changes

- 1f6efc5: Ensure `isLoading` is set to `false` when cancelling the stream due to thread ID change

## 1.0.1

### Patch Changes

- b9be526: Adding functionality to search assistants by name in the in-memory server implementation.
- cc9dc28: Add `values` parameter to thread search

## 1.0.0

### Major Changes

- 1e1ecbb: This release updates the package for compatibility with LangGraph v1.0. See the [v1.0 release notes](https://docs.langchain.com/oss/javascript/releases/langgraph-v1) for details on what's new.

## 0.1.10

### Patch Changes

- 47cdce7: Fix stale values being received by optimistic values callback in `stream.submit(...)`

## 0.1.9

### Patch Changes

- 02beb41: Add support for creating stateless runs

## 0.1.8

### Patch Changes

- 90dcb8b: Add support for managing thread state manually outside of useStream hook via `experimental_thread` option

## 0.1.7

### Patch Changes

- bbc90e6: Fix thread history state being kept stale when changing `thread_id`

## 0.1.6

### Patch Changes

- 5603276: Fix `useStream()` keeping stale thread history when switching threads mid-stream (#1632)
- b65c80b: Add `transport` option to useStream, allowing custom endpoints, that emit compatible Server-Sent Events to be used with `useStream`.
- 5603276: Fix `stop()` behavior when cancelling a resumable stream via `useStream()` (#1610)

## 0.1.5

### Patch Changes

- f21fd04: Fix mutate function in `onCustomEvent` and in `onUpdateEvent` receiving incorrect previous value

## 0.1.4

### Patch Changes

- 599a8c5: Add support for streaming of RemoveMessage in useStream
- 15afabe: Allow `@langchain/core@1.0.0-alpha` installed alongside SDK

## 0.1.3

### Patch Changes

- ba7682f: Add TTL support to ThreadsClient in TypeScript to match Python SDK:

  - `threads.create({ ttl })` now accepts either a number (minutes) or an object `{ ttl: number, strategy?: "delete" }`.
  - `threads.update(threadId, { ttl })` accepts the same forms.

  Numeric TTL values are normalized to `{ ttl, strategy: "delete" }` in the request payload.

## 0.1.2

### Patch Changes

- 3b1e137: Add `description` field for assistants auth handlers

## 0.1.1

### Patch Changes

- 7de6680: Fix `onRequest` not being called when streaming runs or threads (#1585)
- df8b662: Fix interrupts not being exposed in `useStream["interrupt"]` when `fetchStateHistory: false`
- 572de43: feat(threads): add `ids` filter to Threads.search

  - SDK: `ThreadsClient.search` now accepts `ids?: string[]` and forwards it to `/threads/search`.
  - API: `/threads/search` schema accepts `ids` and storage filters by provided thread IDs.

  This enables fetching a specific set of threads directly via the search endpoint, while remaining backward compatible.

## 0.1.0

### Minor Changes

- 35a0f1c: feat(sdk): set default limit of fetch history to 10
- 35a0f1c: feat(sdk): set default of `fetchStateHistory` to `false`

### Patch Changes

- 35a0f1c: chore(sdk): decouple stream manager from React
- 35a0f1c: fix(sdk): prevent partial history from hiding all values

## 0.0.112

### Patch Changes

- a50e02e: feat(sdk): add thread streaming endpoint
- 7e210a1: feat(sdk): add durability param to run methods
- 5766b62: Fix `isThreadLoading: false` when initially mounting in useStream

## 0.0.111

### Patch Changes

- b5f14d0: Add methods to connect with the /count endpoints

## 0.0.109

### Patch Changes

- e8b4540: Add support for select statements in the search endpoints
- 9c57526: fix(sdk): expose subgraph events in useStream callbacks

## 0.0.107

### Patch Changes

- 72386a4: feat(sdk): expose stream metadata from messages via `getMessagesMetadata`
- 3ee5c20: fix(sdk): avoid setting `messages-tuple` if only `getMessagesMetadata` is requested.

## 0.0.106

### Patch Changes

- feat(sdk): allow setting `checkpoint: null` when submitting a run via useStream

## 0.0.105

### Patch Changes

- 7054a6a: add context to assistantBase interface

## 0.0.104

### Patch Changes

- af9ec5a: feat(sdk): add `isThreadLoading` option to `useStream`, handle thread error fetching
- 8e1ec9e: feat(sdk): add Context API support for useStream
- f43e48c: fix(sdk): handle subgraph custom events in stream processing of useStream

## 0.0.103

### Patch Changes

- f1bcec7: Add support for context API

## 0.0.102

### Patch Changes

- 030698f: feat(api): add support for injecting `langgraph_node` in structured logs, expose structlog

## 0.0.101

### Patch Changes

- f5e87cb: fix(sdk): allow async authorize callback

## 0.0.100

### Patch Changes

- a0efb98: Rename `interrupt_id` to `id`

## 0.0.99

### Patch Changes

- 768e2e2: feat(sdk): expose interrupt_id in types

## 0.0.98

### Patch Changes

- ee1defa: feat(sdk): add typing for "tasks" and "checkpoints" stream mode

## 0.0.97

### Patch Changes

- ac7b067: fix(sdk): use `kind` when checking for Studio user

## 0.0.96

### Patch Changes

- 53b8c30: fix(sdk): `runs.join()` returns the thread values

## 0.0.95

### Patch Changes

- 39cc88f: useStream should receive and merge messages from subgraphs
- c1ddda1: Fix fetching state with `fetchStateHistory: false` causing crash if thread is empty

## 0.0.94

### Patch Changes

- 11e95e0: Add isStudioUser for custom auth

## 0.0.93

### Patch Changes

- d53c891: Fix useStream race condition when flushing messages

## 0.0.92

### Patch Changes

- 603daa6: Make history fetching configurable in useStream via `fetchStateHistory`

## 0.0.91

### Patch Changes

- 2f26f2f: Send metadata when creating a new thread

## 0.0.90

### Patch Changes

- c8d7a0a: Add missing optional peer dependency on react-dom
