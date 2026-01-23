---
"@langchain/langgraph": patch
---

Add unified schema support for `StateGraph` constructor

- Support mixing `AnnotationRoot`, Zod schemas, and `StateSchema` for state, input, and output definitions
- Add `{ input, output }` only pattern where state is inferred from input schema
- Add per-node input schema support via `addNode` options
- Deprecate `stateSchema` property in favor of `state`
- Simplify constructor overloads with unified `StateGraphInit` type
