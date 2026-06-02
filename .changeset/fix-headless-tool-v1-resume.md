---
"@langchain/langgraph-sdk": patch
"@langchain/react": patch
"@langchain/vue": patch
"@langchain/angular": patch
"@langchain/svelte": patch
---

fix(sdk): route headless tool resumes through respond on v1 stream

`useStream` was calling `submit(null, { command })` for headless-tool resumes,
which dispatches `run.start` without delivering the tool result. Add
`applyHeadlessToolResumeCommand` to route payloads through `respond` /
`respondAll`, and tighten headless-tool browser tests to assert end-to-end
resume and graph completion.
