# @langchain/langgraph-checkpoint

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
