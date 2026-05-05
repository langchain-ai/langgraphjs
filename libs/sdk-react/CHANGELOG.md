# @langchain/react

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
