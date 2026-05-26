---
"@langchain/langgraph-sdk": patch
"@langchain/react": patch
"@langchain/vue": patch
"@langchain/svelte": patch
"@langchain/angular": patch
---

fix(sdk): unwrap Command tool outputs and hide scoped task tools

Filter wrapper `task` dispatch events from subagent-scoped tool-call
projections and parse embedded ToolMessage results from LangGraph
`Command` payloads on `tool-finished`.
