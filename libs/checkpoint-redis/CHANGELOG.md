# @langchain/langgraph-checkpoint-redis

## 1.0.2

### Patch Changes

- [#1943](https://github.com/langchain-ai/langgraphjs/pull/1943) [`814c76d`](https://github.com/langchain-ai/langgraphjs/commit/814c76dc3938d0f6f7e17ca3bc11d6a12270b2a1) Thanks [@hntrl](https://github.com/hntrl)! - fix(redis): escape RediSearch filter values

  Added proper escaping for filter keys and values when constructing RediSearch queries
  in the `list()` method to handle special characters correctly.

## 1.0.1

### Patch Changes

- 9440d08: Fix LangChain objects not being deserialized properly from checkpointed state

## 1.0.0

### Major Changes

- 1e1ecbb: This release updates the package for compatibility with LangGraph v1.0. See the [v1.0 release notes](https://docs.langchain.com/oss/javascript/releases/langgraph-v1) for details on what's new.

### Patch Changes

- Updated dependencies [1e1ecbb]
  - @langchain/langgraph-checkpoint@1.0.0

## 0.0.2

### Patch Changes

- 926db1e: Allow using @langchain/core@^1.0.0-alpha
