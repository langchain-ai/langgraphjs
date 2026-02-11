# @langchain/langgraph-sdk

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
