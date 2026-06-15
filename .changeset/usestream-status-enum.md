---
"@langchain/langgraph-sdk": minor
"@langchain/react": minor
"@langchain/vue": minor
"@langchain/svelte": minor
"@langchain/angular": minor
---

feat: add a `status` enum to `useStream` alongside `isLoading` across all bindings.

`useStream` now exposes `status: "idle" | "submitting" | "streaming" | "error"`, a single readable lifecycle phase instead of juggling `isLoading`/`error` by hand. `"submitting"` covers the optimistic window after a run is dispatched but before it starts running; `"streaming"` once a root `running` lifecycle is observed. `isLoading` is unchanged and equals `status === "submitting" || status === "streaming"`. Wrapped in each binding's reactive primitive (React value, Vue `ComputedRef`, Svelte getter, Angular `Signal`, plus Angular's `StreamService`).

The core stream runtime gains a `RootSnapshot.isRunning` flag (driven by the lifecycle tracker) plus an exported `deriveStreamStatus` helper and `StreamStatus` type so every framework binding derives the same value.
