# @langchain/langgraph-sdk

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
