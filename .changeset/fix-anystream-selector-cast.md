---
"@langchain/react": patch
"@langchain/vue": patch
"@langchain/svelte": patch
"@langchain/angular": patch
---

fix: make AnyStream a true supertype so selector hooks need no cast

A concrete `useStream<typeof agent>()` handle was not assignable to
`AnyStream` because generic-computed covariant members (`toolCalls`,
`values`) don't widen under `any` — `InferToolCalls<any>[]` resolves to
`AssembledToolCall<…, never>[]`, narrower than a concrete handle. Override
those members with their widest forms (preserving each framework's
reactivity wrapper — plain arrays for React/Svelte, `ShallowRef` for Vue,
`Signal` for Angular) so the message/tool/value selector hooks accept a
fully-typed stream without an `as AnyStream` cast.
