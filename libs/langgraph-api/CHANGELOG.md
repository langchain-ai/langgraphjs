# @langchain/langgraph-api

## 1.4.2

### Patch Changes

- [#2590](https://github.com/langchain-ai/langgraphjs/pull/2590) [`f71e00c`](https://github.com/langchain-ai/langgraphjs/commit/f71e00c52600a6dafacccdde1363e83c17c8d97b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(api): inject langgraph_auth_user on protocol-v2 run.start

  Stamp authenticated user fields onto run config in createOrResumeRun so
  v2 streaming matches the REST runs API. Shared helpers also dedupe REST
  run config auth/header enrichment.

- [#2575](https://github.com/langchain-ai/langgraphjs/pull/2575) [`e1b40c2`](https://github.com/langchain-ai/langgraphjs/commit/e1b40c29e14f8e9fb2696acc62d611e14a813f43) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(cli): support node_version 24 in langgraph.json

  Allow Node 24 in the CLI config schema and Docker base image resolution.
  The langgraphjs-api:24 image is already published from langgraph-api.

- Updated dependencies [[`f71e00c`](https://github.com/langchain-ai/langgraphjs/commit/f71e00c52600a6dafacccdde1363e83c17c8d97b), [`e1b40c2`](https://github.com/langchain-ai/langgraphjs/commit/e1b40c29e14f8e9fb2696acc62d611e14a813f43)]:
  - @langchain/langgraph-ui@1.4.2

## 1.4.1

### Patch Changes

- [#2568](https://github.com/langchain-ai/langgraphjs/pull/2568) [`38d15e2`](https://github.com/langchain-ai/langgraphjs/commit/38d15e2f1f9dded34665a602cd9311cbcf5fbefc) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(langgraph-api): support configurable TypeScript loaders in dev server

  Add `node_loader` to `langgraph.json` (and `LANGGRAPH_NODE_LOADER` env override) so projects using reflect-metadata can use `ts-node` (`--loader ts-node/esm`) instead of the default tsx CLI. Other loaders default to `--import`; only registered shorthands like `ts-node` use `--loader`. `--no-reload` now also disables tsx's internal watch mode. Closes [#1834](https://github.com/langchain-ai/langgraphjs/issues/1834).

- Updated dependencies []:
  - @langchain/langgraph-ui@1.4.1

## 1.4.0

### Minor Changes

- [#2559](https://github.com/langchain-ai/langgraphjs/pull/2559) [`48cbdd2`](https://github.com/langchain-ai/langgraphjs/commit/48cbdd23fdf29277530f6aa05c397c9902e81206) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(langgraph-cli): add `deploy` command for LangSmith Deployment

  Port the Python CLI's `langgraph deploy` workflow to `@langchain/langgraph-cli`, including local and remote build paths, deployment lifecycle subcommands (`list`, `revisions list`, `delete`, `logs`), and host-backend client utilities with tests.

### Patch Changes

- [#2557](https://github.com/langchain-ai/langgraphjs/pull/2557) [`b1e856d`](https://github.com/langchain-ai/langgraphjs/commit/b1e856d987ac16148dc0872d1fecf70e659ef28e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(langgraph-api): preserve non-empty response_metadata on protocol-v2 state messages

  The protocol-v2 state normalizer stripped `response_metadata` from messages,
  dropping data that HITL flows rely on — an interrupt's card is carried on
  `AIMessage.response_metadata` (e.g. `{ cards: ... }`). Non-empty
  `response_metadata` is now retained so the card reaches the client.

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

- Updated dependencies [[`48cbdd2`](https://github.com/langchain-ai/langgraphjs/commit/48cbdd23fdf29277530f6aa05c397c9902e81206)]:
  - @langchain/langgraph-ui@1.4.0

## 1.3.1

### Patch Changes

- [#2527](https://github.com/langchain-ai/langgraphjs/pull/2527) [`9e114e5`](https://github.com/langchain-ai/langgraphjs/commit/9e114e55d362a874878a817740de42fd62ae9db7) Thanks [@christian-bromann](https://github.com/christian-bromann)! - chore(deps): remove uuid dependency in favor of embedded uuid in core

  Replace direct `uuid` package imports with `@langchain/core/utils/uuid` across
  langgraph packages to deduplicate dependencies and align with @langchain/core's
  embedded UUID utilities.

- Updated dependencies [[`9e114e5`](https://github.com/langchain-ai/langgraphjs/commit/9e114e55d362a874878a817740de42fd62ae9db7)]:
  - @langchain/langgraph-ui@1.3.1

## 1.3.0

### Minor Changes

- [#2505](https://github.com/langchain-ai/langgraphjs/pull/2505) [`cad31b4`](https://github.com/langchain-ai/langgraphjs/commit/cad31b42f001a87fcdf57c4c084c655c8762b6a5) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Consolidate the protocol session's channel inference, channel-set validation, and namespace prefix matching onto the shared `@langchain/langgraph/stream` helpers instead of maintaining local copies. This removes duplicated logic across `session/index.mts`, `session/namespace.mts`, `session/internal-types.mts`, and `service.mts`.

  This also aligns SSE event-sink filtering (`matchesSinkFilter`) with the WebSocket subscription matcher: both now normalize dynamic namespace suffixes (e.g. a `["fetcher"]` namespace filter matches an event emitted under `["fetcher:<uuid>"]`). Previously the SSE path used a stricter exact-segment match.

  Because the session now imports `@langchain/langgraph/stream`, the `@langchain/langgraph` peer dependency floor is raised to `^1.3.6` (the first release that ships the `/stream` entrypoint).

### Patch Changes

- Updated dependencies []:
  - @langchain/langgraph-ui@1.3.0

## 1.2.5

### Patch Changes

- [`658a076`](https://github.com/langchain-ai/langgraphjs/commit/658a076d5b50af9f5b96ab99f26ed629da6e182f) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(langgraph): forward named custom stream channels consistently

  Forward remote `StreamChannel` emissions as `custom:<name>` protocol events and normalize them back to custom-channel payloads in the API session. This aligns JavaScript stream-channel forwarding with the protocol subscription shape used by remote clients, so `custom:<name>` subscriptions receive extension channel data consistently.

- Updated dependencies []:
  - @langchain/langgraph-ui@1.2.5

## 1.2.4

### Patch Changes

- [#2344](https://github.com/langchain-ai/langgraphjs/pull/2344) [`0125920`](https://github.com/langchain-ai/langgraphjs/commit/0125920a2c4a87dc1d66aaf541ea16146f8cf842) Thanks [@dependabot](https://github.com/apps/dependabot)! - chore(deps): bump uuid to 14.0.0 and keep checkpoint ID ordering stable

  Bump `uuid` from 10.x/13.x to 14.0.0 across packages. Starting with uuid 11, `v6({ clockseq })` no longer advances the sub-millisecond time counter when an explicit `clockseq` is passed, so checkpoint IDs created within the same millisecond were ordered only by `clockseq`. Since checkpoint IDs are sorted lexicographically, this broke ordering — most visibly for the negative `clockseq` used by the first ("input") checkpoint, which sorted as the newest.

  `uuid6()` now maintains its own monotonic `(msecs, nsecs)` clock (mirroring uuid 10's internal v1 behavior) so the time component is always strictly increasing and checkpoint ordering no longer depends on the `clockseq` value. `emptyCheckpoint()` also uses a non-negative `clockseq`.

- Updated dependencies []:
  - @langchain/langgraph-ui@1.2.4

## 1.2.3

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

- Updated dependencies [[`80a8c12`](https://github.com/langchain-ai/langgraphjs/commit/80a8c1200a240fd984edc4deb26a7787d08c7532)]:
  - @langchain/langgraph-ui@1.2.3

## 1.2.2

### Patch Changes

- [#2396](https://github.com/langchain-ai/langgraphjs/pull/2396) [`9b20df0`](https://github.com/langchain-ai/langgraphjs/commit/9b20df081a82b79efca3dfd2c128243889b11eb8) Thanks [@hntrl](https://github.com/hntrl)! - fix(langgraph-cli): accept hyphenated prerelease tags in `api_version` values.

- Updated dependencies []:
  - @langchain/langgraph-ui@1.2.2

## 1.2.2-rc.0

### Patch Changes

- [#2396](https://github.com/langchain-ai/langgraphjs/pull/2396) [`9b20df0`](https://github.com/langchain-ai/langgraphjs/commit/9b20df081a82b79efca3dfd2c128243889b11eb8) Thanks [@hntrl](https://github.com/hntrl)! - fix(langgraph-cli): accept hyphenated prerelease tags in `api_version` values.

- Updated dependencies [[`44746b1`](https://github.com/langchain-ai/langgraphjs/commit/44746b1a3b5b49737542b120b9e45d6f94181113), [`4cc6491`](https://github.com/langchain-ai/langgraphjs/commit/4cc6491844f21ed0fc737eaef8498133daa877f7), [`ae8af2d`](https://github.com/langchain-ai/langgraphjs/commit/ae8af2d75aef9a7bbd930d221d1ce03e7fbb90ad), [`4fd1e9f`](https://github.com/langchain-ai/langgraphjs/commit/4fd1e9f5720361a86a386a286ad8fcc824643280), [`2ad1aa4`](https://github.com/langchain-ai/langgraphjs/commit/2ad1aa48c6a3f45340b4833e6de555fdc7348d15), [`75e651b`](https://github.com/langchain-ai/langgraphjs/commit/75e651b9cff1a1e39ad6513b8a5e9b565b9ad7fe), [`f1d651a`](https://github.com/langchain-ai/langgraphjs/commit/f1d651ae14ca178f4a915ac853ba9b439cd55ba3)]:
  - @langchain/langgraph-sdk@1.9.3-rc.0
  - @langchain/langgraph@1.3.1-rc.0
  - @langchain/langgraph-ui@1.2.2-rc.0

## 1.2.1

### Patch Changes

- [#2366](https://github.com/langchain-ai/langgraphjs/pull/2366) [`2bb66bf`](https://github.com/langchain-ai/langgraphjs/commit/2bb66bf816a8b18b2968ed885ef2df15f684cb4e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): update endpoints

- Updated dependencies []:
  - @langchain/langgraph-ui@1.2.1

## 1.2.0

### Minor Changes

- [#2314](https://github.com/langchain-ai/langgraphjs/pull/2314) [`085a07f`](https://github.com/langchain-ai/langgraphjs/commit/085a07f569b6d7d79728eb7eb6eb3a0c67fcdefb) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Add the thread-scoped event streaming protocol used by the new SDK streaming
  clients.

  This release adds protocol routes for WebSocket and SSE/HTTP streaming,
  including thread-local command handling, filtered subscriptions, event replay,
  state inspection, checkpoint listing/forking, interrupt input, agent tree
  queries, and run start/resume commands. Stream events are normalized into the
  canonical protocol shape with ordered sequence IDs so clients can safely
  dedupe, resume subscriptions, and coordinate multiple projections from the same
  run.

  The experimental embed server now supports the same protocol flow, so embedded
  graphs can serve the new SDK transports without standing up a separate
  LangGraph API deployment. The server also gains protocol session tests and
  fixture graphs covering deep agents, interrupts, subgraphs, and SDK transport
  behavior.

### Patch Changes

- Updated dependencies []:
  - @langchain/langgraph-ui@1.2.0

## 1.1.17

### Patch Changes

- Updated dependencies []:
  - @langchain/langgraph-ui@1.1.17

## 1.1.16

### Patch Changes

- Updated dependencies []:
  - @langchain/langgraph-ui@1.1.16

## 1.1.15

### Patch Changes

- [#2032](https://github.com/langchain-ai/langgraphjs/pull/2032) [`730b82d`](https://github.com/langchain-ai/langgraphjs/commit/730b82d2309e65e6b2ed99ebff2aa052cff8ed35) Thanks [@hntrl](https://github.com/hntrl)! - fix(langgraph-api): use UUIDv7 instead of UUIDv4 in embed server

  Switches thread and run ID generation from `uuidv4` to `uuidv7` in the experimental embed server. UUIDv7 is time-ordered, which improves sortability and database index performance for IDs.

- Updated dependencies []:
  - @langchain/langgraph-ui@1.1.15

## 1.1.14

### Patch Changes

- [#1984](https://github.com/langchain-ai/langgraphjs/pull/1984) [`aa8e878`](https://github.com/langchain-ai/langgraphjs/commit/aa8e878e5b71128685ab7e7a79c96bd2519c0123) Thanks [@colifran](https://github.com/colifran)! - feat: add tools stream mode for tool lifecycle events

- Updated dependencies [[`aa8e878`](https://github.com/langchain-ai/langgraphjs/commit/aa8e878e5b71128685ab7e7a79c96bd2519c0123), [`1b088e5`](https://github.com/langchain-ai/langgraphjs/commit/1b088e578aaef7d231f37885b94bfd763f99a775)]:
  - @langchain/langgraph-sdk@1.6.5
  - @langchain/langgraph-ui@1.1.14

## 2.0.0

### Patch Changes

- Updated dependencies [[`242cfbb`](https://github.com/langchain-ai/langgraphjs/commit/242cfbbb6ab375c91bd021f64ec652840af591a9)]:
  - @langchain/langgraph-sdk@2.0.0
  - @langchain/langgraph-ui@2.0.0

## 1.1.13

### Patch Changes

- [#1960](https://github.com/langchain-ai/langgraphjs/pull/1960) [`4ebe31e`](https://github.com/langchain-ai/langgraphjs/commit/4ebe31ec6ea289f2eeff324fb1875af869d543c9) Thanks [@hntrl](https://github.com/hntrl)! - relax langsmith dep

- Updated dependencies []:
  - @langchain/langgraph-ui@1.1.13

## 1.1.12

### Patch Changes

- [#1939](https://github.com/langchain-ai/langgraphjs/pull/1939) [`ad39dcf`](https://github.com/langchain-ai/langgraphjs/commit/ad39dcfddf575a5e5438cd40b284ac0d549b5827) Thanks [@hntrl](https://github.com/hntrl)! - Enhanced JSON schema extraction for Studio with multi-tier strategy:

  - **StateSchema support**: Extract schemas from `StateSchema` instances using `getJsonSchema()` and `getInputJsonSchema()` methods, preserving `jsonSchemaExtra` metadata (e.g., `langgraph_type: "messages"`)
  - **Improved Zod handling**: Fall back to Zod registry extraction for `withLangGraph()` schemas, then direct Zod conversion for plain Zod schemas
  - **Reduced reliance on TypeScript parser**: Only fall back to the brittle TypeScript AST parser when all runtime extraction methods fail

  Extraction priority:

  1. StateSchema (handles `jsonSchemaExtra` via `ReducedValue`)
  2. Zod via `schemaMetaRegistry` (handles `jsonSchemaExtra` from `withLangGraph()`)
  3. Direct Zod conversion (no `jsonSchemaExtra`, but better than static parsing)
  4. Static TypeScript parser (fallback)

- Updated dependencies []:
  - @langchain/langgraph-ui@1.1.12

## 1.1.11

### Patch Changes

- [#1873](https://github.com/langchain-ai/langgraphjs/pull/1873) [`2b9f3ee`](https://github.com/langchain-ai/langgraphjs/commit/2b9f3ee83d0b8ba023e7a52b938260af3f6433d4) Thanks [@andrewnguonly](https://github.com/andrewnguonly)! - Add delete_threads query parameter to delete assistants API.

- Updated dependencies []:
  - @langchain/langgraph-ui@1.1.11

## 1.1.10

### Patch Changes

- [#1862](https://github.com/langchain-ai/langgraphjs/pull/1862) [`e7aeffe`](https://github.com/langchain-ai/langgraphjs/commit/e7aeffeb72aaccd8c94f8e78708f747ce21bf23c) Thanks [@dqbd](https://github.com/dqbd)! - retry release: bump @hono/zod-validator

- Updated dependencies []:
  - @langchain/langgraph-ui@1.1.10

## 1.1.9

### Patch Changes

- [#1856](https://github.com/langchain-ai/langgraphjs/pull/1856) [`a9fa28b`](https://github.com/langchain-ai/langgraphjs/commit/a9fa28b6adad16050fcf5d5876a3924253664217) Thanks [@christian-bromann](https://github.com/christian-bromann)! - retry release: bump @hono/zod-validator

- Updated dependencies []:
  - @langchain/langgraph-ui@1.1.9

## 1.1.8

### Patch Changes

- [#1853](https://github.com/langchain-ai/langgraphjs/pull/1853) [`a84c1ff`](https://github.com/langchain-ai/langgraphjs/commit/a84c1ff18289653ff4715bd0db4ac3d06600556e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - retry release: bump @hono/zod-validator

- Updated dependencies []:
  - @langchain/langgraph-ui@1.1.8

## 1.1.7

### Patch Changes

- [#1850](https://github.com/langchain-ai/langgraphjs/pull/1850) [`e9f7e8e`](https://github.com/langchain-ai/langgraphjs/commit/e9f7e8e9e6b8851cb7dd68e31d2f1867b62bd6bd) Thanks [@christian-bromann](https://github.com/christian-bromann)! - retry release: bump @hono/zod-validator

- Updated dependencies []:
  - @langchain/langgraph-ui@1.1.7

## 1.1.6

### Patch Changes

- 3ec85a4: retry release: bump @hono/zod-validator
  - @langchain/langgraph-ui@1.1.6

## 1.1.5

### Patch Changes

- 3613386: retry release: bump @hono/zod-validator
  - @langchain/langgraph-ui@1.1.5

## 1.1.4

### Patch Changes

- 730dc7c: fix(api): bump @hono/zod-validator
  - @langchain/langgraph-ui@1.1.4

## 1.1.3

### Patch Changes

- @langchain/langgraph-ui@1.1.3

## 1.1.2

### Patch Changes

- d08e484: Fix semver range for SDK
  - @langchain/langgraph-ui@1.1.2

## 1.1.1

### Patch Changes

- 35e8fc7: Add name parameter to assistants count API.
- Updated dependencies [e19e76c]
- Updated dependencies [fa6c009]
- Updated dependencies [35e8fc7]
- Updated dependencies [b78a738]
  - @langchain/langgraph-sdk@1.1.0
  - @langchain/langgraph-ui@1.1.1

## 1.1.0

### Patch Changes

- @langchain/langgraph-ui@1.1.0

## 1.0.4

### Patch Changes

- b9be526: Adding functionality to search assistants by name in the in-memory server implementation.
  - @langchain/langgraph-ui@1.0.4

## 1.0.3

### Patch Changes

- 6cd8ecb: Remove Zod 3.x dependency constraint to allow Zod 4.x and avoid installing duplicate Zod packages
- Updated dependencies [6cd8ecb]
  - @langchain/langgraph-ui@1.0.3

## 1.0.2

### Patch Changes

- ebe5ae7: Add back support for older versions of LangChain / LangGraph
  - @langchain/langgraph-ui@1.0.2

## 1.0.1

### Patch Changes

- 610e1e1: Hotfix graph resolution for createAgent
  - @langchain/langgraph-ui@1.0.1

## 1.0.0

### Major Changes

- 1e1ecbb: This release updates the package for compatibility with LangGraph v1.0. See the [v1.0 release notes](https://docs.langchain.com/oss/javascript/releases/langgraph-v1) for details on what's new.

### Patch Changes

- Updated dependencies [1e1ecbb]
  - @langchain/langgraph-ui@1.0.0
  - @langchain/langgraph-checkpoint@1.0.0
  - @langchain/langgraph-sdk@1.0.0

## 0.0.71

### Patch Changes

- f5865ac: Update API spec to match python api
  - @langchain/langgraph-ui@0.0.71

## 0.0.70

### Patch Changes

- 636e142: Updated types to match python api
  - @langchain/langgraph-ui@0.0.70

## 0.0.69

### Patch Changes

- f2aa533: Updated typing of auth filters
  - @langchain/langgraph-ui@0.0.69

## 0.0.68

### Patch Changes

- @langchain/langgraph-ui@0.0.68

## 0.0.67

### Patch Changes

- e23fa7f: Add support for `sort_by`, `sort_order` and `select` when searching for assistants and add support for pagination headers.
  - @langchain/langgraph-ui@0.0.67

## 0.0.66

### Patch Changes

- 5176f1c: chore(api): add description field for assistants
- 68a1aa8: fix(api): call threads:create auth handler when copying a thread
  - @langchain/langgraph-ui@0.0.66

## 0.0.65

### Patch Changes

- 0aefafe: Skip auth middleware when requesting JS/CSS assets for built-in generative UI
  - @langchain/langgraph-ui@0.0.65

## 0.0.64

### Patch Changes

- 30bcfcd: Assume `http` protocol only when accessing UI components from frontend served from `localhost` or `127.0.0.1` (#1596, #1573)
- 572de43: feat(threads): add `ids` filter to Threads.search

  - SDK: `ThreadsClient.search` now accepts `ids?: string[]` and forwards it to `/threads/search`.
  - API: `/threads/search` schema accepts `ids` and storage filters by provided thread IDs.

  This enables fetching a specific set of threads directly via the search endpoint, while remaining backward compatible.

  - @langchain/langgraph-ui@0.0.64

## 0.0.63

### Patch Changes

- c9d4dfd: Add support for @langchain/core 1.0.0-alpha and @langchain/langgraph 1.0.0-alpha
  - @langchain/langgraph-ui@0.0.63

## 0.0.62

### Patch Changes

- c868796: Exports more graph-related helper functions.
  - @langchain/langgraph-ui@0.0.62

## 0.0.61

### Patch Changes

- a334897: feat(api): add /count endpoints for threads and assistants
- 9357bb7: chore(api): abstract internal operations away from createServer
- 9f13d74: fix(api): prevent overriding default CORS config when applying a single override
  - @langchain/langgraph-ui@0.0.61

## 0.0.60

### Patch Changes

- 9c57526: fix(api): serialization of "checkpoints" and "tasks" stream modes
  - @langchain/langgraph-ui@0.0.60

## 0.0.59

### Patch Changes

- 3412f9f: fix(api): unintended schema inference to BaseMessage[] for all state keys when `strictFunctionTypes: true`
  - @langchain/langgraph-ui@0.0.59

## 0.0.58

### Patch Changes

- f65f619: fix(api): send Content-Location header for stateless runs
- c857357: feat(api): harden embed server, implement missing endpoints needed for interrupts
  - @langchain/langgraph-ui@0.0.58

## 0.0.57

### Patch Changes

- 31cc9f7: support description property for `langgraph.json`
  - @langchain/langgraph-ui@0.0.57

## 0.0.56

### Patch Changes

- 3c390c9: fix(api): parser: sanitise generated symbol names, honor typescript extension
  - @langchain/langgraph-ui@0.0.56

## 0.0.55

### Patch Changes

- ef84039: fix(api): place the schema inference template next to the graph code, use whole path for symbol name
- 7edf347: exlcude meta routes from auth
- 77b21d5: add installed langgraph version to info endpoint for js server
  - @langchain/langgraph-ui@0.0.55

## 0.0.54

### Patch Changes

- 1777878: fix(cli): only warn the user if an invalid LangSmith API key is passed while tracing is enabled
  - @langchain/langgraph-ui@0.0.54

## 0.0.53

### Patch Changes

- f1bcec7: Add support for Context API in in-memory dev server
  - @langchain/langgraph-ui@0.0.53

## 0.0.52

### Patch Changes

- 030698f: feat(api): add support for injecting `langgraph_node` in structured logs, expose structlog
  - @langchain/langgraph-ui@0.0.52

## 0.0.51

### Patch Changes

- @langchain/langgraph-ui@0.0.51

## 0.0.50

### Patch Changes

- @langchain/langgraph-ui@0.0.50

## 0.0.49

### Patch Changes

- ee1defa: feat(api): pass through "tasks" and "checkpoints" stream mode
  - @langchain/langgraph-ui@0.0.49

## 0.0.48

### Patch Changes

- ac7b067: fix(sdk): use `kind` when checking for Studio user
- Updated dependencies [ac7b067]
  - @langchain/langgraph-ui@0.0.48

## 0.0.47

### Patch Changes

- 39cc88f: Fix apply namespace to messages-tuple stream mode
- c1ddda1: Embed methods for obtaining state should use `getGraph(...)`
- Updated dependencies [39cc88f]
- Updated dependencies [c1ddda1]
  - @langchain/langgraph-ui@0.0.47

## 0.0.46

### Patch Changes

- d172de3: Fix apply namespace to messages-tuple stream mode
- Updated dependencies [d172de3]
  - @langchain/langgraph-ui@0.0.46

## 0.0.45

### Patch Changes

- 603daa6: Embed should properly handle `payload.checkpoint` and `payload.checkpoint_id`
- Updated dependencies [603daa6]
  - @langchain/langgraph-ui@0.0.45

## 0.0.44

### Patch Changes

- 2f26f2f: Expose get/delete thread endpoint to embed server
- Updated dependencies [2f26f2f]
  - @langchain/langgraph-ui@0.0.44

## 0.0.43

### Patch Changes

- ce0a39a: Fix invalid package.json dependencies
- Updated dependencies [ce0a39a]
  - @langchain/langgraph-ui@0.0.43

## 0.0.42

### Patch Changes

- 972b66a: Support gen UI components namespaced with a hyphen
- Updated dependencies [972b66a]
  - @langchain/langgraph-ui@0.0.42
