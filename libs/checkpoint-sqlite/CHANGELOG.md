# @langchain/langgraph-checkpoint-sqlite

## 1.0.3

### Patch Changes

- [#2516](https://github.com/langchain-ai/langgraphjs/pull/2516) [`f6a6d26`](https://github.com/langchain-ai/langgraphjs/commit/f6a6d26b7e69003c4fa052f3cd3319f3e72f0f8f) Thanks [@jackjin1997](https://github.com/jackjin1997)! - fix: `SqliteSaver.putWrites` now honors `WRITES_IDX_MAP`, pinning special channels (`__error__`, `__scheduled__`, `__interrupt__`, `__resume__`) to fixed negative indices instead of the call-local ordinal. Previously a follow-up `putWrites([[INTERRUPT, …]], taskId)` for the same checkpoint silently `REPLACE`d the regular write previously stored at `idx=0` for that task, losing data. The conflict-resolution clause also now matches the Python checkpointer contract: `OR REPLACE` only when every channel is a special one (so e.g. INTERRUPT→RESUME state transitions overwrite), `OR IGNORE` otherwise.

## 1.0.2

### Patch Changes

- [#2504](https://github.com/langchain-ai/langgraphjs/pull/2504) [`e8a0940`](https://github.com/langchain-ai/langgraphjs/commit/e8a09409ac4a997012e78081160c91188ebe39fc) Thanks [@jackjin1997](https://github.com/jackjin1997)! - fix: `SqliteSaver.list({}, { filter })` now honors arbitrary metadata keys (e.g. `tenant_id`, `env`), matching the behavior of the MongoDB, Postgres, and Redis checkpointers. Previously only `source`, `step`, and `parents` were honored — any other key was silently dropped, returning unfiltered results.

## 1.0.1

### Patch Changes

- [#1902](https://github.com/langchain-ai/langgraphjs/pull/1902) [`2378b9e`](https://github.com/langchain-ai/langgraphjs/commit/2378b9e951ff245a3e8a502acf42be55cce35a46) Thanks [@warjiang](https://github.com/warjiang)! - chore: upgrade better-sqlite

## 1.0.0

### Major Changes

- 1e1ecbb: This release updates the package for compatibility with LangGraph v1.0. See the [v1.0 release notes](https://docs.langchain.com/oss/javascript/releases/langgraph-v1) for details on what's new.

### Patch Changes

- Updated dependencies [1e1ecbb]
  - @langchain/langgraph-checkpoint@1.0.0

## 0.2.1

### Patch Changes

- 11c7807: Add support for @langchain/core 1.0.0-alpha

## 0.2.0

### Minor Changes

- ccbcbc1: Add delete thread method to checkpointers
- Updated dependencies [773ec0d]
  - @langchain/langgraph-checkpoint@0.1.0

### Patch Changes

- Updated dependencies [ccbcbc1]
- Updated dependencies [10f292a]
- Updated dependencies [3fd7f73]
