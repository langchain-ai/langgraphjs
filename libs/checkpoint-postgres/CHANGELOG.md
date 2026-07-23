# @langchain/langgraph-checkpoint-postgres

## 1.0.4

### Patch Changes

- [#2566](https://github.com/langchain-ai/langgraphjs/pull/2566) [`091a46f`](https://github.com/langchain-ai/langgraphjs/commit/091a46f32ddd3a85ee89e35fb9ea953dfc4cf8b4) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(langgraph-checkpoint-postgres): prevent createAgent failures with PostgresSaver

  Add BaseCheckpointSaver.toJSON() so ConfigurableModel can stringify runnable config without traversing pg Pool timers, and default missing checkpoint maps on load/copy so resume no longer crashes on undefined versions_seen. Closes [#1808](https://github.com/langchain-ai/langgraphjs/issues/1808).

## 1.0.3

### Patch Changes

- [#2512](https://github.com/langchain-ai/langgraphjs/pull/2512) [`375c73f`](https://github.com/langchain-ai/langgraphjs/commit/375c73fcd1ef06145301df80466fda35c0a99385) Thanks [@jackjin1997](https://github.com/jackjin1997)! - fix: reject SQL `LIKE` wildcards (`%`, `_`) and the backslash escape character in `PostgresStore` namespace labels. `BaseStore.search()` matches namespaces via `namespace_path LIKE ${prefix}%`, and these characters in caller-supplied namespace labels are interpreted as wildcards by Postgres even through a bound parameter — letting a namespace prefix of `["%"]` match every namespace in the store across tenants. `validateNamespace` now throws for these characters at all `search` / `get` / `put` entrypoints, keeping store-wide consistency. CWE-1336.

## 1.0.2

### Patch Changes

- [#2255](https://github.com/langchain-ai/langgraphjs/pull/2255) [`e82a50b`](https://github.com/langchain-ai/langgraphjs/commit/e82a50b961a9413dab1ad2248747d5c73a6a1e58) Thanks [@leesta24](https://github.com/leesta24)! - fix(checkpoint-postgres): move serialization outside transaction in put()

## 1.0.1

### Patch Changes

- [#1979](https://github.com/langchain-ai/langgraphjs/pull/1979) [`d65f5a7`](https://github.com/langchain-ai/langgraphjs/commit/d65f5a75e58e282fea831d8f126391823f241a78) Thanks [@Siretu](https://github.com/Siretu)! - fix: quote PostgreSQL schema identifiers to support schemas with dashes

## 1.0.0

### Major Changes

- 1e1ecbb: This release updates the package for compatibility with LangGraph v1.0. See the [v1.0 release notes](https://docs.langchain.com/oss/javascript/releases/langgraph-v1) for details on what's new.

### Patch Changes

- Updated dependencies [1e1ecbb]
  - @langchain/langgraph-checkpoint@1.0.0

## 0.1.2

### Patch Changes

- 11c7807: Add support for @langchain/core 1.0.0-alpha

## 0.1.1

### Patch Changes

- 42ced3a: Add Store implemention for Postgres

## 0.1.0

### Minor Changes

- ccbcbc1: Add delete thread method to checkpointers
- Updated dependencies [773ec0d]
  - @langchain/langgraph-checkpoint@0.1.0

### Patch Changes

- Updated dependencies [ccbcbc1]
- Updated dependencies [10f292a]
- Updated dependencies [3fd7f73]
