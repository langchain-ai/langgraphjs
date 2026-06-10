---
"@langchain/langgraph-sdk": patch
"@langchain/react": patch
"@langchain/svelte": patch
"@langchain/vue": patch
"@langchain/angular": patch
---

feat(stream): add per-event side-effect selector

Add `useChannelEffect` (React/Svelte/Vue) / `injectChannelEffect` (Angular), a side-effect counterpart to `useChannel` that invokes an `onEvent` callback once per raw protocol event without re-rendering. This is the idiomatic v1 replacement for the old `onLangChainEvent` / `onCustomEvent` callbacks for analytics and logging. Backed by a new framework-agnostic `acquireChannelEffect` helper in `@langchain/langgraph-sdk/stream` that shares a ref-counted subscription with matching `useChannel` consumers.
