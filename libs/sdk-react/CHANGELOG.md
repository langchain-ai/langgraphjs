# @langchain/react

## 1.0.26

### Patch Changes

- Updated dependencies [[`0558e47`](https://github.com/langchain-ai/langgraphjs/commit/0558e472b7697304c62cb6fe69cc3005e8e1a457)]:
  - @langchain/langgraph-sdk@1.9.25

## 1.0.25

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

## 1.0.24

### Patch Changes

- Updated dependencies [[`2134c8a`](https://github.com/langchain-ai/langgraphjs/commit/2134c8a2c0bc8dd2ebea33e1191c8dd0c4b83236)]:
  - @langchain/langgraph-sdk@1.9.23

## 1.0.23

### Patch Changes

- Updated dependencies [[`ba31f04`](https://github.com/langchain-ai/langgraphjs/commit/ba31f045d1d458a456c6f6441e8ee81d32c5c700), [`e7e8035`](https://github.com/langchain-ai/langgraphjs/commit/e7e8035fadca5f0d4cbc55bbbb77e65878ab2952), [`9e114e5`](https://github.com/langchain-ai/langgraphjs/commit/9e114e55d362a874878a817740de42fd62ae9db7)]:
  - @langchain/langgraph-sdk@1.9.22

## 1.0.22

### Patch Changes

- [#2522](https://github.com/langchain-ai/langgraphjs/pull/2522) [`3855985`](https://github.com/langchain-ai/langgraphjs/commit/3855985dd049739f145295d236ce6aa02ae2fb0e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(stream): add per-event side-effect selector

  Add `useChannelEffect` (React/Svelte/Vue) / `injectChannelEffect` (Angular), a side-effect counterpart to `useChannel` that invokes an `onEvent` callback once per raw protocol event without re-rendering. This is the idiomatic v1 replacement for the old `onLangChainEvent` / `onCustomEvent` callbacks for analytics and logging. Backed by a new framework-agnostic `acquireChannelEffect` helper in `@langchain/langgraph-sdk/stream` that shares a ref-counted subscription with matching `useChannel` consumers.

- Updated dependencies [[`3855985`](https://github.com/langchain-ai/langgraphjs/commit/3855985dd049739f145295d236ce6aa02ae2fb0e), [`7c3e9e9`](https://github.com/langchain-ai/langgraphjs/commit/7c3e9e93f3c7ec1dc654dac8ee8c03562ee8337b), [`17c44a3`](https://github.com/langchain-ai/langgraphjs/commit/17c44a38b7478e2bc4fe908a54c78ef33fb68ba3)]:
  - @langchain/langgraph-sdk@1.9.21

## 1.0.21

### Patch Changes

- [#2515](https://github.com/langchain-ai/langgraphjs/pull/2515) [`49b8c1a`](https://github.com/langchain-ai/langgraphjs/commit/49b8c1a04cf03a77069a955816b0f5af2f68ab41) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix: make AnyStream a true supertype so selector hooks need no cast

  A concrete `useStream<typeof agent>()` handle was not assignable to
  `AnyStream` because generic-computed covariant members (`toolCalls`,
  `values`) don't widen under `any` — `InferToolCalls<any>[]` resolves to
  `AssembledToolCall<…, never>[]`, narrower than a concrete handle. Override
  those members with their widest forms (preserving each framework's
  reactivity wrapper — plain arrays for React/Svelte, `ShallowRef` for Vue,
  `Signal` for Angular) so the message/tool/value selector hooks accept a
  fully-typed stream without an `as AnyStream` cast.

## 1.0.20

### Patch Changes

- [#2508](https://github.com/langchain-ai/langgraphjs/pull/2508) [`41cd05a`](https://github.com/langchain-ai/langgraphjs/commit/41cd05a411ed262443c2bd1048e1b728b7331ac6) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): hydrate custom HttpAgentServerAdapter via transport getState

  StreamController now prefers adapter getState() before client.threads.getState,
  HttpAgentServerAdapter implements GET /threads/:id/state, and useStream inherits
  apiUrl from the transport so hydration no longer defaults to localhost:8123.

- Updated dependencies [[`41cd05a`](https://github.com/langchain-ai/langgraphjs/commit/41cd05a411ed262443c2bd1048e1b728b7331ac6)]:
  - @langchain/langgraph-sdk@1.9.20

## 1.0.19

### Patch Changes

- Updated dependencies [[`cad31b4`](https://github.com/langchain-ai/langgraphjs/commit/cad31b42f001a87fcdf57c4c084c655c8762b6a5)]:
  - @langchain/langgraph-sdk@1.9.19

## 1.0.18

### Patch Changes

- [#2500](https://github.com/langchain-ai/langgraphjs/pull/2500) [`f67772f`](https://github.com/langchain-ai/langgraphjs/commit/f67772ff3f7ac13d81576d395d7529de4eb4390b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): resume useChannel subscriptions across serial runs

  Enable `resumeOnPause` on the channel projection so `useChannel` keeps
  accumulating events across prompts on the same thread. Clarify selector
  docs and JSDoc: `useChannel` for the full event stream, `useExtension`
  for the latest payload.

- Updated dependencies [[`f67772f`](https://github.com/langchain-ai/langgraphjs/commit/f67772ff3f7ac13d81576d395d7529de4eb4390b)]:
  - @langchain/langgraph-sdk@1.9.18

## 1.0.17

### Patch Changes

- [#2494](https://github.com/langchain-ai/langgraphjs/pull/2494) [`0a0e04e`](https://github.com/langchain-ai/langgraphjs/commit/0a0e04e9ff7e82fd08411cc0094e1f94729a1e1e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): revive automatic optimistic submit echo

  Echo `submit()` input into `values` / `messages` immediately with client-side
  id minting and id-based reconciliation as the server streams back. Expose
  per-message `optimisticStatus` via message metadata (`pending` → `sent` /
  `failed`), shallow-merge non-message keys with rollback when no `values`
  arrive, and add an `optimistic: false` hook opt-out. Plumb through React,
  Vue, Svelte, and Angular with browser e2e coverage.

- [#2497](https://github.com/langchain-ai/langgraphjs/pull/2497) [`a9aa8d6`](https://github.com/langchain-ai/langgraphjs/commit/a9aa8d6a9b23f5f7d4c56889fa68697b1e076b31) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): reconcile subagents and subgraphs on thread reconnect

  Seed deep-agent subagent cards from checkpoint messages and subgraph hosts from a single bounded `getHistory` read during `hydrate()`, so parallel fan-out discovery reappears immediately on refresh instead of waiting for SSE replay. Subagent execution namespaces are promoted through the existing guarded discovery state machine (bulk at hydrate, lazily per opened card via the selector layer). The getHistory cost is O(1) in requests regardless of fan-out width.

- Updated dependencies [[`0a0e04e`](https://github.com/langchain-ai/langgraphjs/commit/0a0e04e9ff7e82fd08411cc0094e1f94729a1e1e), [`658a076`](https://github.com/langchain-ai/langgraphjs/commit/658a076d5b50af9f5b96ab99f26ed629da6e182f), [`a9aa8d6`](https://github.com/langchain-ai/langgraphjs/commit/a9aa8d6a9b23f5f7d4c56889fa68697b1e076b31)]:
  - @langchain/langgraph-sdk@1.9.17

## 1.0.16

### Patch Changes

- Updated dependencies [[`244c24e`](https://github.com/langchain-ai/langgraphjs/commit/244c24eaccff4009df7d83e4320e51a4b310b15f)]:
  - @langchain/langgraph-sdk@1.9.16

## 1.0.15

### Patch Changes

- Updated dependencies [[`9861f42`](https://github.com/langchain-ai/langgraphjs/commit/9861f42cc4fa23d9e80ae45a76d511d7618cda07)]:
  - @langchain/langgraph-sdk@1.9.15

## 1.0.14

### Patch Changes

- Updated dependencies [[`ba583b6`](https://github.com/langchain-ai/langgraphjs/commit/ba583b601d284c689bbfc15397686f1aa7481fba)]:
  - @langchain/langgraph-sdk@1.9.14

## 1.0.13

### Patch Changes

- Updated dependencies [[`0bbe66e`](https://github.com/langchain-ai/langgraphjs/commit/0bbe66e31de3abe7526c7810755a40c31bc60e0d)]:
  - @langchain/langgraph-sdk@1.9.13

## 1.0.12

### Patch Changes

- [#2467](https://github.com/langchain-ai/langgraphjs/pull/2467) [`0491534`](https://github.com/langchain-ai/langgraphjs/commit/04915347128e40fc9617647cadba6b472a357d36) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): route headless tool resumes through respond on v1 stream

  `useStream` was calling `submit(null, { command })` for headless-tool resumes,
  which dispatches `run.start` without delivering the tool result. Add
  `applyHeadlessToolResumeCommand` to route payloads through `respond` /
  `respondAll`, and tighten headless-tool browser tests to assert end-to-end
  resume and graph completion.

- Updated dependencies [[`0491534`](https://github.com/langchain-ai/langgraphjs/commit/04915347128e40fc9617647cadba6b472a357d36)]:
  - @langchain/langgraph-sdk@1.9.12

## 1.0.11

### Patch Changes

- Updated dependencies [[`863b555`](https://github.com/langchain-ai/langgraphjs/commit/863b555346de02c2c0be290e877b7d260a3f8856), [`0125920`](https://github.com/langchain-ai/langgraphjs/commit/0125920a2c4a87dc1d66aaf541ea16146f8cf842)]:
  - @langchain/langgraph-sdk@1.9.11

## 1.0.10

### Patch Changes

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

- Updated dependencies [[`80c2806`](https://github.com/langchain-ai/langgraphjs/commit/80c2806cb2da93745a640664bd0cf603c2361da9), [`80a8c12`](https://github.com/langchain-ai/langgraphjs/commit/80a8c1200a240fd984edc4deb26a7787d08c7532), [`2c14b12`](https://github.com/langchain-ai/langgraphjs/commit/2c14b12a80c306578563e77595943037c7c4844d)]:
  - @langchain/langgraph-sdk@1.9.10

## 1.0.9

### Patch Changes

- Updated dependencies [[`dbbcb63`](https://github.com/langchain-ai/langgraphjs/commit/dbbcb636e742c38e89854a8ae7ef4e1566d44343)]:
  - @langchain/langgraph-sdk@1.9.9

## 1.0.8

### Patch Changes

- [#2438](https://github.com/langchain-ai/langgraphjs/pull/2438) [`29d2bde`](https://github.com/langchain-ai/langgraphjs/commit/29d2bde235bf85e8a5e1dd59a997266ff894484b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): cancel runs on stop by default and add disconnect()

  `stream.stop()` now calls `client.runs.cancel` for the active run before disconnecting the client (default `{ cancel: true }`). Join/rejoin UIs can call `stream.disconnect()` or `stop({ cancel: false })` to leave the agent running server-side.

  This fills a missing gap we found when migrating to v1.

- Updated dependencies [[`29d2bde`](https://github.com/langchain-ai/langgraphjs/commit/29d2bde235bf85e8a5e1dd59a997266ff894484b)]:
  - @langchain/langgraph-sdk@1.9.8

## 1.0.7

### Patch Changes

- [#2435](https://github.com/langchain-ai/langgraphjs/pull/2435) [`cfc8d27`](https://github.com/langchain-ai/langgraphjs/commit/cfc8d274e4dc99cb73ebd9abc4f971622105f08e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): unwrap Command tool outputs and hide scoped task tools

  Filter wrapper `task` dispatch events from subagent-scoped tool-call
  projections and parse embedded ToolMessage results from LangGraph
  `Command` payloads on `tool-finished`.

- Updated dependencies [[`cfc8d27`](https://github.com/langchain-ai/langgraphjs/commit/cfc8d274e4dc99cb73ebd9abc4f971622105f08e), [`6b188e8`](https://github.com/langchain-ai/langgraphjs/commit/6b188e80ab989fc8396e1926f729d93b786ca671)]:
  - @langchain/langgraph-sdk@1.9.7

## 1.0.6

### Patch Changes

- [#2430](https://github.com/langchain-ai/langgraphjs/pull/2430) [`f99941f`](https://github.com/langchain-ai/langgraphjs/commit/f99941f5fe8671ddcb6a78e93e5e05f4028d4af4) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): clear subgraph and subagent discovery on thread swap

  Reset discovery stores in `StreamController.#teardownThread()` so starting a
  new thread does not leave stale subgraph cards or subagent entries from the
  previous run.

- Updated dependencies [[`f99941f`](https://github.com/langchain-ai/langgraphjs/commit/f99941f5fe8671ddcb6a78e93e5e05f4028d4af4)]:
  - @langchain/langgraph-sdk@1.9.6

## 1.0.5

### Patch Changes

- [#2421](https://github.com/langchain-ai/langgraphjs/pull/2421) [`3529e38`](https://github.com/langchain-ai/langgraphjs/commit/3529e3831a488134e7dfaefa4ed7fb1140cf8bb6) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(stream): align AssembledToolCall typing with pre-v1 expectations

  Make `InferToolCalls` resolve to generic `AssembledToolCall` unions, expose
  sync `status`/`error` for reactive bindings, and align type tests across
  React, Vue, Svelte, and Angular SDK packages.

- Updated dependencies [[`3529e38`](https://github.com/langchain-ai/langgraphjs/commit/3529e3831a488134e7dfaefa4ed7fb1140cf8bb6)]:
  - @langchain/langgraph-sdk@1.9.5

## 1.0.4

### Patch Changes

- Updated dependencies [[`9d3c9dd`](https://github.com/langchain-ai/langgraphjs/commit/9d3c9dd3182059f9eca9fd9b14d8f7466b4338c4)]:
  - @langchain/langgraph-sdk@1.9.4

## 1.0.3

### Patch Changes

- Updated dependencies [[`44746b1`](https://github.com/langchain-ai/langgraphjs/commit/44746b1a3b5b49737542b120b9e45d6f94181113), [`4cc6491`](https://github.com/langchain-ai/langgraphjs/commit/4cc6491844f21ed0fc737eaef8498133daa877f7), [`ae8af2d`](https://github.com/langchain-ai/langgraphjs/commit/ae8af2d75aef9a7bbd930d221d1ce03e7fbb90ad), [`01dd046`](https://github.com/langchain-ai/langgraphjs/commit/01dd0462ed300dee5a9a51f229e6c401315f070c), [`2ad1aa4`](https://github.com/langchain-ai/langgraphjs/commit/2ad1aa48c6a3f45340b4833e6de555fdc7348d15), [`75e651b`](https://github.com/langchain-ai/langgraphjs/commit/75e651b9cff1a1e39ad6513b8a5e9b565b9ad7fe), [`f1d651a`](https://github.com/langchain-ai/langgraphjs/commit/f1d651ae14ca178f4a915ac853ba9b439cd55ba3)]:
  - @langchain/langgraph-sdk@1.9.3

## 1.0.3-rc.0

### Patch Changes

- Updated dependencies [[`44746b1`](https://github.com/langchain-ai/langgraphjs/commit/44746b1a3b5b49737542b120b9e45d6f94181113), [`4cc6491`](https://github.com/langchain-ai/langgraphjs/commit/4cc6491844f21ed0fc737eaef8498133daa877f7), [`ae8af2d`](https://github.com/langchain-ai/langgraphjs/commit/ae8af2d75aef9a7bbd930d221d1ce03e7fbb90ad), [`2ad1aa4`](https://github.com/langchain-ai/langgraphjs/commit/2ad1aa48c6a3f45340b4833e6de555fdc7348d15), [`75e651b`](https://github.com/langchain-ai/langgraphjs/commit/75e651b9cff1a1e39ad6513b8a5e9b565b9ad7fe), [`f1d651a`](https://github.com/langchain-ai/langgraphjs/commit/f1d651ae14ca178f4a915ac853ba9b439cd55ba3)]:
  - @langchain/langgraph-sdk@1.9.3-rc.0

## 1.0.2

### Patch Changes

- Updated dependencies [[`4c6875c`](https://github.com/langchain-ai/langgraphjs/commit/4c6875c1e3dd32857d526925865c389e4e9c10c2), [`a5089cd`](https://github.com/langchain-ai/langgraphjs/commit/a5089cda1d9db1e4b50c17cdd12a770a67279905)]:
  - @langchain/langgraph-sdk@1.9.2

## 1.0.1

### Patch Changes

- Updated dependencies [[`2bb66bf`](https://github.com/langchain-ai/langgraphjs/commit/2bb66bf816a8b18b2968ed885ef2df15f684cb4e)]:
  - @langchain/langgraph-sdk@1.9.1

## 1.0.0

### Major Changes

- [#2314](https://github.com/langchain-ai/langgraphjs/pull/2314) [`085a07f`](https://github.com/langchain-ai/langgraphjs/commit/085a07f569b6d7d79728eb7eb6eb3a0c67fcdefb) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Add the React event streaming integration.

  React applications can now use the shared event streaming runtime through
  `useStream`, `useProjection`, `useSuspenseStream`, `StreamProvider`, and
  focused selector hooks for messages, values, tool calls, custom channels,
  extensions, media, message metadata, and submission queues. The new integration
  supports thread-scoped runs, reattachment, interrupts, WebSocket and
  SSE/custom transports, headless tools, subgraphs, subagents, typed stream
  extensions, and strongly typed state/tool-call inference.

  This release also adds media helpers for streaming UI experiences, including
  `useMediaURL`, `useAudioPlayer`, and `useVideoPlayer`, plus selectors for
  audio, images, video, and files. Shared transport, media, protocol event,
  message metadata, and discovery types are exported from the package so React
  components can compose richer streaming interfaces without deep imports.

  The package documentation and tests have been expanded around custom
  transports, selectors, interrupts, multimodal streaming, suspense, submission
  queues, headless tools, subagents, type safety, and migration from the previous
  streaming API.

### Patch Changes

- Updated dependencies [[`085a07f`](https://github.com/langchain-ai/langgraphjs/commit/085a07f569b6d7d79728eb7eb6eb3a0c67fcdefb), [`d1e2fda`](https://github.com/langchain-ai/langgraphjs/commit/d1e2fda1b1165e122362780a62ab8d2ebff9f9b9)]:
  - @langchain/langgraph-sdk@1.9.0

## 0.3.5

### Patch Changes

- [#2354](https://github.com/langchain-ai/langgraphjs/pull/2354) [`733d28e`](https://github.com/langchain-ai/langgraphjs/commit/733d28ea637135876375fa005a8d8a5605a692e6) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): pin framework SDKs to langgraph-sdk version

## 0.3.4

### Patch Changes

- [#2340](https://github.com/langchain-ai/langgraphjs/pull/2340) [`6bab458`](https://github.com/langchain-ai/langgraphjs/commit/6bab458d4a03ce2d7b2708488b92226899eb94d4) Thanks [@cwlbraa](https://github.com/cwlbraa)! - Respect `fetchStateHistory` when restoring subagent history.

- Updated dependencies [[`6bab458`](https://github.com/langchain-ai/langgraphjs/commit/6bab458d4a03ce2d7b2708488b92226899eb94d4)]:
  - @langchain/langgraph-sdk@1.8.10

## 0.3.3

### Patch Changes

- [#2292](https://github.com/langchain-ai/langgraphjs/pull/2292) [`33293c7`](https://github.com/langchain-ai/langgraphjs/commit/33293c7f3f110bb462d77a2f8671e5b9d0e84b63) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): buffer subagent messages instead of dropping them

- Updated dependencies [[`33293c7`](https://github.com/langchain-ai/langgraphjs/commit/33293c7f3f110bb462d77a2f8671e5b9d0e84b63)]:
  - @langchain/langgraph-sdk@1.8.8

## 0.3.2

### Patch Changes

- [#2285](https://github.com/langchain-ai/langgraphjs/pull/2285) [`a5dfdb6`](https://github.com/langchain-ai/langgraphjs/commit/a5dfdb61c7af0b957b0064b02cb390a11cd59b56) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): detect interrupt for Python agents

- Updated dependencies [[`a5dfdb6`](https://github.com/langchain-ai/langgraphjs/commit/a5dfdb61c7af0b957b0064b02cb390a11cd59b56)]:
  - @langchain/langgraph-sdk@1.8.7

## 0.3.1

### Patch Changes

- [`b4a841c`](https://github.com/langchain-ai/langgraphjs/commit/b4a841c4b369db7f0fa93fe1de6b3b1ac3e8d3fb) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): bump all packages

- Updated dependencies [[`b4a841c`](https://github.com/langchain-ai/langgraphjs/commit/b4a841c4b369db7f0fa93fe1de6b3b1ac3e8d3fb)]:
  - @langchain/langgraph-sdk@1.8.6

## 0.3.0

### Minor Changes

- [#2281](https://github.com/langchain-ai/langgraphjs/pull/2281) [`2b62610`](https://github.com/langchain-ai/langgraphjs/commit/2b626107101bddb13cf662e1583ea1a828c6e0cd) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(sdk): support for headless tools

## 0.2.4

### Patch Changes

- [#2279](https://github.com/langchain-ai/langgraphjs/pull/2279) [`3bbb3ff`](https://github.com/langchain-ai/langgraphjs/commit/3bbb3ff65aa3c1de96c7d751c14dc9ee11e3b095) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): better type inferrence

- Updated dependencies [[`3bbb3ff`](https://github.com/langchain-ai/langgraphjs/commit/3bbb3ff65aa3c1de96c7d751c14dc9ee11e3b095), [`0d04099`](https://github.com/langchain-ai/langgraphjs/commit/0d04099958dcca0a1ed053e6a41cc2c12bab78f5)]:
  - @langchain/langgraph-sdk@1.8.5

## 0.2.3

### Patch Changes

- [#2250](https://github.com/langchain-ai/langgraphjs/pull/2250) [`8eaf410`](https://github.com/langchain-ai/langgraphjs/commit/8eaf41069264753947e5c9633b567e589dc0e532) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): skip post-stream getHistory for zero-arity onFinish

- Updated dependencies [[`8eaf410`](https://github.com/langchain-ai/langgraphjs/commit/8eaf41069264753947e5c9633b567e589dc0e532)]:
  - @langchain/langgraph-sdk@1.8.2

## 0.2.2

### Patch Changes

- [#2237](https://github.com/langchain-ai/langgraphjs/pull/2237) [`88726df`](https://github.com/langchain-ai/langgraphjs/commit/88726dfe222aed64e5cd5dfa6f77f886b5a0d205) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Extract shared `WithClassMessages<T>` type to `@langchain/langgraph-sdk/ui`

- [#2243](https://github.com/langchain-ai/langgraphjs/pull/2243) [`7dfcbff`](https://github.com/langchain-ai/langgraphjs/commit/7dfcbffd4805b2b4cc41f07f30be57ed732786b4) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(skd): normalize interrupts between JS and Python

- Updated dependencies [[`88726df`](https://github.com/langchain-ai/langgraphjs/commit/88726dfe222aed64e5cd5dfa6f77f886b5a0d205), [`7dfcbff`](https://github.com/langchain-ai/langgraphjs/commit/7dfcbffd4805b2b4cc41f07f30be57ed732786b4)]:
  - @langchain/langgraph-sdk@1.8.1

## 0.2.1

### Patch Changes

- [#2228](https://github.com/langchain-ai/langgraphjs/pull/2228) [`07e9044`](https://github.com/langchain-ai/langgraphjs/commit/07e9044487aeed6f6b40b2b49a52615cda90dcc1) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Fix @langchain/react hook dispatch and Suspense cache ergonomics

- Updated dependencies [[`414a7ad`](https://github.com/langchain-ai/langgraphjs/commit/414a7adf908ba4f7ffef4985df3a95f14202591b)]:
  - @langchain/langgraph-sdk@1.8.0

## 0.2.0

### Minor Changes

- [#2224](https://github.com/langchain-ai/langgraphjs/pull/2224) [`2cb6edd`](https://github.com/langchain-ai/langgraphjs/commit/2cb6edd890d8ac0eb8d99a6e44e1f19b88b9e203) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(react): add `useSuspenseStream` hook for React Suspense / Error Boundary integration

- [#2223](https://github.com/langchain-ai/langgraphjs/pull/2223) [`09b9b60`](https://github.com/langchain-ai/langgraphjs/commit/09b9b60fe5acf57d76cda19dbced995bda748204) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat: add provider/context patterns for React, Vue, Angular, and Svelte SDKs

### Patch Changes

- [`fe4dd5b`](https://github.com/langchain-ai/langgraphjs/commit/fe4dd5b85d285f78b6d499b1f1013927931ea634) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Support `onFinish` callback in custom transport, ensuring it is called when the stream completes.

- [`fe4dd5b`](https://github.com/langchain-ai/langgraphjs/commit/fe4dd5b85d285f78b6d499b1f1013927931ea634) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): fetch subagent history

- [`fe4dd5b`](https://github.com/langchain-ai/langgraphjs/commit/fe4dd5b85d285f78b6d499b1f1013927931ea634) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(react/vue/svelte/angular): clean up Readme and dev deps

- [`fe4dd5b`](https://github.com/langchain-ai/langgraphjs/commit/fe4dd5b85d285f78b6d499b1f1013927931ea634) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Forward streamSubgraphs in custom transports

- Updated dependencies [[`fe4dd5b`](https://github.com/langchain-ai/langgraphjs/commit/fe4dd5b85d285f78b6d499b1f1013927931ea634), [`fe4dd5b`](https://github.com/langchain-ai/langgraphjs/commit/fe4dd5b85d285f78b6d499b1f1013927931ea634), [`fe4dd5b`](https://github.com/langchain-ai/langgraphjs/commit/fe4dd5b85d285f78b6d499b1f1013927931ea634)]:
  - @langchain/langgraph-sdk@1.7.5

## 0.1.3

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

- Updated dependencies [[`745112c`](https://github.com/langchain-ai/langgraphjs/commit/745112c0d754d0403aab415f46550dd61474dbd9), [`8faf05c`](https://github.com/langchain-ai/langgraphjs/commit/8faf05c939051effda4d3566d2f24a0a96ae7a56)]:
  - @langchain/langgraph-sdk@1.7.1

## 0.1.2

### Patch Changes

- [#2162](https://github.com/langchain-ai/langgraphjs/pull/2162) [`b518c47`](https://github.com/langchain-ai/langgraphjs/commit/b518c474f659538a62f4960b73b39c6d69f58807) Thanks [@christian-bromann](https://github.com/christian-bromann)! - update deps

## 0.1.1

### Patch Changes

- [`9c2bc9e`](https://github.com/langchain-ai/langgraphjs/commit/9c2bc9ef32abe5b33c8e67e7c8c7b3da7de5e0b0) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(react): bump version

## 0.1.0

### Minor Changes

- [#2001](https://github.com/langchain-ai/langgraphjs/pull/2001) [`e051ef6`](https://github.com/langchain-ai/langgraphjs/commit/e051ef6aa8301f39badc9f496cbacef73bb4e2c4) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(react): initial first release for `@langchain/react`

### Patch Changes

- Updated dependencies [[`e051ef6`](https://github.com/langchain-ai/langgraphjs/commit/e051ef6aa8301f39badc9f496cbacef73bb4e2c4)]:
  - @langchain/langgraph-sdk@1.7.0
