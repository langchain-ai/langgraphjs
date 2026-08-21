---
"@langchain/langgraph-sdk": patch
---

fix(sdk): drop unused svelte and vue peer dependencies

The Svelte and Vue adapters live in `@langchain/svelte` and
`@langchain/vue`, but the core SDK still declared both as optional peers.
Scanners like Socket count optional peers as part of the package graph, so
the SDK was being flagged for obfuscated-code alerts in `clsx` and
`entities` — packages it never loads. React stays a peer because `./react`
and `./react-ui` still ship here.
