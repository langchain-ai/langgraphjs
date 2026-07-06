# @langchain/langgraph-ui

## 1.4.2

### Patch Changes

- [#2590](https://github.com/langchain-ai/langgraphjs/pull/2590) [`f71e00c`](https://github.com/langchain-ai/langgraphjs/commit/f71e00c52600a6dafacccdde1363e83c17c8d97b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(api): inject langgraph_auth_user on protocol-v2 run.start

  Stamp authenticated user fields onto run config in createOrResumeRun so
  v2 streaming matches the REST runs API. Shared helpers also dedupe REST
  run config auth/header enrichment.

- [#2575](https://github.com/langchain-ai/langgraphjs/pull/2575) [`e1b40c2`](https://github.com/langchain-ai/langgraphjs/commit/e1b40c29e14f8e9fb2696acc62d611e14a813f43) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(cli): support node_version 24 in langgraph.json

  Allow Node 24 in the CLI config schema and Docker base image resolution.
  The langgraphjs-api:24 image is already published from langgraph-api.

## 1.4.1

## 1.4.0

### Minor Changes

- [#2559](https://github.com/langchain-ai/langgraphjs/pull/2559) [`48cbdd2`](https://github.com/langchain-ai/langgraphjs/commit/48cbdd23fdf29277530f6aa05c397c9902e81206) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(langgraph-cli): add `deploy` command for LangSmith Deployment

  Port the Python CLI's `langgraph deploy` workflow to `@langchain/langgraph-cli`, including local and remote build paths, deployment lifecycle subcommands (`list`, `revisions list`, `delete`, `logs`), and host-backend client utilities with tests.

## 1.3.1

### Patch Changes

- [#2527](https://github.com/langchain-ai/langgraphjs/pull/2527) [`9e114e5`](https://github.com/langchain-ai/langgraphjs/commit/9e114e55d362a874878a817740de42fd62ae9db7) Thanks [@christian-bromann](https://github.com/christian-bromann)! - chore(deps): remove uuid dependency in favor of embedded uuid in core

  Replace direct `uuid` package imports with `@langchain/core/utils/uuid` across
  langgraph packages to deduplicate dependencies and align with @langchain/core's
  embedded UUID utilities.

## 1.3.0

## 1.2.5

## 1.2.4

## 1.2.3

### Patch Changes

- [#2443](https://github.com/langchain-ai/langgraphjs/pull/2443) [`80a8c12`](https://github.com/langchain-ai/langgraphjs/commit/80a8c1200a240fd984edc4deb26a7787d08c7532) Thanks [@christian-bromann](https://github.com/christian-bromann)! - refactor(sdk): drop StreamSubmitOptions.command and simplify forkFrom

  Remove the misleading submit({ command }) surface from protocol-v2
  StreamController; HITL resume is respond() only. Accept forkFrom as a
  plain checkpoint id string and align protocol-v2 servers and docs.

## 1.2.2

## 1.2.2-rc.0

## 1.2.1

## 1.2.0

## 1.1.17

## 1.1.16

## 1.1.15

## 1.1.14

## 2.0.0

## 1.1.13

## 1.1.12

## 1.1.11

## 1.1.10

## 1.1.9

## 1.1.8

## 1.1.7

## 1.1.6

## 1.1.5

## 1.1.4

## 1.1.3

## 1.1.2

## 1.1.1

## 1.1.0

## 1.0.4

## 1.0.3

### Patch Changes

- 6cd8ecb: Remove Zod 3.x dependency constraint to allow Zod 4.x and avoid installing duplicate Zod packages

## 1.0.2

## 1.0.1

## 1.0.0

### Major Changes

- 1e1ecbb: This release updates the package for compatibility with LangGraph v1.0. See the [v1.0 release notes](https://docs.langchain.com/oss/javascript/releases/langgraph-v1) for details on what's new.

## 0.0.71

## 0.0.70

## 0.0.69

## 0.0.68

## 0.0.67

## 0.0.66

## 0.0.65

## 0.0.64

## 0.0.63

## 0.0.62

## 0.0.61

## 0.0.60

## 0.0.59

## 0.0.58

## 0.0.57

## 0.0.56

## 0.0.55

## 0.0.54

## 0.0.53

## 0.0.52

## 0.0.51

## 0.0.50

## 0.0.49

## 0.0.48

### Patch Changes

- ac7b067: fix(sdk): use `kind` when checking for Studio user

## 0.0.47

### Patch Changes

- 39cc88f: Fix apply namespace to messages-tuple stream mode
- c1ddda1: Embed methods for obtaining state should use `getGraph(...)`

## 0.0.46

### Patch Changes

- d172de3: Fix apply namespace to messages-tuple stream mode

## 0.0.45

### Patch Changes

- 603daa6: Embed should properly handle `payload.checkpoint` and `payload.checkpoint_id`

## 0.0.44

### Patch Changes

- 2f26f2f: Expose get/delete thread endpoint to embed server

## 0.0.43

### Patch Changes

- ce0a39a: Fix invalid package.json dependencies

## 0.0.42

### Patch Changes

- 972b66a: Support gen UI components namespaced with a hyphen
