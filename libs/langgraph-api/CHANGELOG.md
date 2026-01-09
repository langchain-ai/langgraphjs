# @langchain/langgraph-api

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
