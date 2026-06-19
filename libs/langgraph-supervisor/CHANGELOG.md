# @langchain/langgraph-supervisor

## 1.1.1

### Patch Changes

- [#2527](https://github.com/langchain-ai/langgraphjs/pull/2527) [`9e114e5`](https://github.com/langchain-ai/langgraphjs/commit/9e114e55d362a874878a817740de42fd62ae9db7) Thanks [@christian-bromann](https://github.com/christian-bromann)! - chore(deps): remove uuid dependency in favor of embedded uuid in core

  Replace direct `uuid` package imports with `@langchain/core/utils/uuid` across
  langgraph packages to deduplicate dependencies and align with @langchain/core's
  embedded UUID utilities.

## 1.1.0

### Minor Changes

- [#2521](https://github.com/langchain-ai/langgraphjs/pull/2521) [`56682a6`](https://github.com/langchain-ai/langgraphjs/commit/56682a69a24d0dfb210f1fb5187c51e3adc356bf) Thanks [@open-swe](https://github.com/apps/open-swe)! - feat(langgraph-supervisor): Add `addHandoffMessages` to `createSupervisor` and `createHandoffTool`, allowing supervisor-to-agent handoff bookkeeping messages to be omitted from the expert agent's message history. When `addHandoffBackMessages` is not provided, it now defaults to the same value as `addHandoffMessages`, matching the Python package behavior.

  `createHandoffTool` now also accepts `description` as the preferred option name while continuing to support the existing `agentDescription` option as deprecated for backwards compatibility.

### Patch Changes

- [#2407](https://github.com/langchain-ai/langgraphjs/pull/2407) [`59d4765`](https://github.com/langchain-ai/langgraphjs/commit/59d4765870bc0cddf3ef594b128ab3280533cb6c) Thanks [@pragnyanramtha](https://github.com/pragnyanramtha)! - Normalize all whitespace in supervisor handoff tool names.

## 1.0.4

### Patch Changes

- [#2344](https://github.com/langchain-ai/langgraphjs/pull/2344) [`0125920`](https://github.com/langchain-ai/langgraphjs/commit/0125920a2c4a87dc1d66aaf541ea16146f8cf842) Thanks [@dependabot](https://github.com/apps/dependabot)! - chore(deps): bump uuid to 14.0.0 and keep checkpoint ID ordering stable

  Bump `uuid` from 10.x/13.x to 14.0.0 across packages. Starting with uuid 11, `v6({ clockseq })` no longer advances the sub-millisecond time counter when an explicit `clockseq` is passed, so checkpoint IDs created within the same millisecond were ordered only by `clockseq`. Since checkpoint IDs are sorted lexicographically, this broke ordering — most visibly for the negative `clockseq` used by the first ("input") checkpoint, which sorted as the newest.

  `uuid6()` now maintains its own monotonic `(msecs, nsecs)` clock (mirroring uuid 10's internal v1 behavior) so the time component is always strictly increasing and checkpoint ordering no longer depends on the `clockseq` value. `emptyCheckpoint()` also uses a non-negative `clockseq`.

## 1.0.3

### Patch Changes

- [#2317](https://github.com/langchain-ai/langgraphjs/pull/2317) [`c088c76`](https://github.com/langchain-ai/langgraphjs/commit/c088c7659c18edf26091813ff384f48f5335bef6) Thanks [@fish895623](https://github.com/fish895623)! - feat(supervisor): widen agents type to accept createAgent graphs

## 1.0.2

## 1.0.2-rc.0

### Patch Changes

- Updated dependencies [[`4fd1e9f`](https://github.com/langchain-ai/langgraphjs/commit/4fd1e9f5720361a86a386a286ad8fcc824643280)]:
  - @langchain/langgraph@1.3.1-rc.0

## 1.0.1

### Patch Changes

- b1ed761: bump zod dependency

## 1.0.0

### Major Changes

- 1e1ecbb: This release updates the package for compatibility with LangGraph v1.0. See the [v1.0 release notes](https://docs.langchain.com/oss/javascript/releases/langgraph-v1) for details on what's new.

## 0.0.20

### Patch Changes

- 19b4f3d: Add support for RemoteGraph agents in supervisor (#1461)

## 0.0.19

### Patch Changes

- 4a15efa: feat(supervisor): add passthrough support for preModelHook and postModelHook

## 0.0.18

### Patch Changes

- cb4b17a: feat(langgraph): use createReactAgent description for supervisor agent handoffs

## 0.0.17

### Patch Changes

- 55f15d4: feat: support contextSchema in supervisor

## 0.0.16

### Patch Changes

- Updated dependencies [10432a4]
- Updated dependencies [f1bcec7]
- Updated dependencies [14dd523]
- Updated dependencies [5f7ee26]
- Updated dependencies [fa78796]
- Updated dependencies [565f472]
  - @langchain/langgraph@0.4.0

## 0.0.15

### Patch Changes

- aa7542e: Fix issue with bindTools called twice when using with newer LangChain LLM models
