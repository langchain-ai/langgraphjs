# @langchain/vue

## 0.1.4

### Patch Changes

- [#2199](https://github.com/langchain-ai/langgraphjs/pull/2199) [`2b77530`](https://github.com/langchain-ai/langgraphjs/commit/2b775302b6d212e72af1d169cddf6e13e6f4ddad) Thanks [@pawel-twardziak](https://github.com/pawel-twardziak)! - Support `onFinish` callback in custom transport, ensuring it is called when the stream completes.

- [#2194](https://github.com/langchain-ai/langgraphjs/pull/2194) [`ff43458`](https://github.com/langchain-ai/langgraphjs/commit/ff434584fd34cd1ade8dea5eeeb08816948fb648) Thanks [@pawel-twardziak](https://github.com/pawel-twardziak)! - Fix `useStream` to properly handle `threadId` option and auto-fetch thread history when a `threadId` is provided.

- [#2191](https://github.com/langchain-ai/langgraphjs/pull/2191) [`963db6f`](https://github.com/langchain-ai/langgraphjs/commit/963db6fbc775649bd63f6abb74c9c90e3f455bd5) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): fetch subagent history

- [#2214](https://github.com/langchain-ai/langgraphjs/pull/2214) [`bd02965`](https://github.com/langchain-ai/langgraphjs/commit/bd02965cdf63cca1b88f3fa34506d548b559de64) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(react/vue/svelte/angular): clean up Readme and dev deps

- [#2215](https://github.com/langchain-ai/langgraphjs/pull/2215) [`a55b6fe`](https://github.com/langchain-ai/langgraphjs/commit/a55b6fe3a0e34dc15f6b2967e9a050ecfe161a98) Thanks [@Albert-Gao](https://github.com/Albert-Gao)! - Forward streamSubgraphs in custom transports

- Updated dependencies [[`2b77530`](https://github.com/langchain-ai/langgraphjs/commit/2b775302b6d212e72af1d169cddf6e13e6f4ddad), [`963db6f`](https://github.com/langchain-ai/langgraphjs/commit/963db6fbc775649bd63f6abb74c9c90e3f455bd5), [`a55b6fe`](https://github.com/langchain-ai/langgraphjs/commit/a55b6fe3a0e34dc15f6b2967e9a050ecfe161a98)]:
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
