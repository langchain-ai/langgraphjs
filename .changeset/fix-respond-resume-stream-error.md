---
"@langchain/langgraph-sdk": patch
---

fix(sdk): surface resumed run failures on stream.error

Route `respond()` and `respondAll()` through a coordinator dispatch path that
writes the reactive `rootStore.error` slot when a resumed run reaches a failed
terminal or when `input.respond` dispatch fails, matching submit() behavior so
framework consumers (e.g. API-key retry UIs) observe resume failures via
`stream.error` instead of only `isLoading` transitions.
