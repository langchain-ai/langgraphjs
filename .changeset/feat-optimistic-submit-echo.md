---
"@langchain/langgraph-sdk": patch
"@langchain/react": patch
"@langchain/vue": patch
"@langchain/svelte": patch
"@langchain/angular": patch
---

fix(sdk): revive automatic optimistic submit echo

Echo `submit()` input into `values` / `messages` immediately with client-side
id minting and id-based reconciliation as the server streams back. Expose
per-message `optimisticStatus` via message metadata (`pending` → `sent` /
`failed`), shallow-merge non-message keys with rollback when no `values`
arrive, and add an `optimistic: false` hook opt-out. Plumb through React,
Vue, Svelte, and Angular with browser e2e coverage.
