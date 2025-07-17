# @langchain/langgraph-sdk

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
