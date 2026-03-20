# @langchain/vue

## 0.3.0

### Minor Changes

- [#2227](https://github.com/langchain-ai/langgraphjs/pull/2227) [`414a7ad`](https://github.com/langchain-ai/langgraphjs/commit/414a7adf908ba4f7ffef4985df3a95f14202591b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat: extract shared orchestrator to eliminate duplicated code across SDK packages

### Patch Changes

- [#2230](https://github.com/langchain-ai/langgraphjs/pull/2230) [`11acfc1`](https://github.com/langchain-ai/langgraphjs/commit/11acfc137b65c7e28c3fab61444c00db3e4be229) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(vue): integrate LangChainPlugin with useStream and fix subagent reactivity

- Updated dependencies [[`414a7ad`](https://github.com/langchain-ai/langgraphjs/commit/414a7adf908ba4f7ffef4985df3a95f14202591b)]:
  - @langchain/langgraph-sdk@1.8.0

## 0.2.0

### Minor Changes

- [#2220](https://github.com/langchain-ai/langgraphjs/pull/2220) [`2d254e2`](https://github.com/langchain-ai/langgraphjs/commit/2d254e27571d9e323699deaabcabb78b1da4fb33) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(vue): Accept MaybeRefOrGetter for reactive options in useStream

- [#2223](https://github.com/langchain-ai/langgraphjs/pull/2223) [`09b9b60`](https://github.com/langchain-ai/langgraphjs/commit/09b9b60fe5acf57d76cda19dbced995bda748204) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat: add provider/context patterns for React, Vue, Angular, and Svelte SDKs

### Patch Changes

- [`fe4dd5b`](https://github.com/langchain-ai/langgraphjs/commit/fe4dd5b85d285f78b6d499b1f1013927931ea634) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Support `onFinish` callback in custom transport, ensuring it is called when the stream completes.

- [`fe4dd5b`](https://github.com/langchain-ai/langgraphjs/commit/fe4dd5b85d285f78b6d499b1f1013927931ea634) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Fix `useStream` to properly handle `threadId` option and auto-fetch thread history when a `threadId` is provided.

- [#2218](https://github.com/langchain-ai/langgraphjs/pull/2218) [`b14c308`](https://github.com/langchain-ai/langgraphjs/commit/b14c3081c75d6be5488760c12e67231228b638d7) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(vue): remove misleading .value usage from README template examples

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

- [`9c2bc9e`](https://github.com/langchain-ai/langgraphjs/commit/9c2bc9ef32abe5b33c8e67e7c8c7b3da7de5e0b0) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(vue): bump version

## 0.1.0

### Minor Changes

- [#2001](https://github.com/langchain-ai/langgraphjs/pull/2001) [`e051ef6`](https://github.com/langchain-ai/langgraphjs/commit/e051ef6aa8301f39badc9f496cbacef73bb4e2c4) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(vue): initial first release for `@langchain/vue`

### Patch Changes

- Updated dependencies [[`e051ef6`](https://github.com/langchain-ai/langgraphjs/commit/e051ef6aa8301f39badc9f496cbacef73bb4e2c4)]:
  - @langchain/langgraph-sdk@1.7.0
