---
"@langchain/langgraph-sdk": patch
"@langchain/react": patch
"@langchain/angular": patch
"@langchain/vue": patch
"@langchain/svelte": patch
---

fix(sdk): resolve respond() namespace from interrupt id

When callers pass `{ interruptId }` without `namespace`, look the
namespace up on `thread.interrupts` instead of defaulting to root.
