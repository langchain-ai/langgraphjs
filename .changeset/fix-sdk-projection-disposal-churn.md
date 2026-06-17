---
"@langchain/langgraph-sdk": patch
---

fix(sdk): avoid scoped stream resubscribe churn

Defer final projection disposal by one microtask so framework bindings that release and immediately reacquire the same scoped projection during reactive updates keep the existing stream subscription instead of rotating through root-only and scoped SSE filters.
