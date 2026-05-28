---
"@langchain/langgraph-sdk": patch
"@langchain/langgraph-api": patch
"@langchain/react": patch
"@langchain/angular": patch
"@langchain/svelte": patch
"@langchain/vue": patch
---

protocol-v2: add `respondAll()` and run config/metadata on interrupt resume

The stream controller (and the React/Angular/Svelte/Vue wrappers) gain a
`respondAll(responsesById, options)` method to resume several interrupts
pending at the same checkpoint in a single command — required for runs that
pause on multiple interrupts at once (e.g. parallel tool-authorization
prompts), which sequential `respond()` calls cannot handle.

`respond()` now takes an options object (`{ interruptId?, namespace?,
config?, metadata? }`) so a resumed run can carry the same run-level config
(model, user context, …) and metadata (trigger source, test flags, …) a
fresh `submit()` would. The protocol-v2 reference servers read the new
`responses` batch and `config` / `metadata` fields leniently and fold them
onto the run that services the `input.respond` command.
