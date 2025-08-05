# @langchain/langgraph-api

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
