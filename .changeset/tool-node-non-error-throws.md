---
"@langchain/langgraph": patch
---

fix(langgraph): handle non-`Error` values thrown by tools in `ToolNode`

A tool that throws a string now produces `Error: <string>` instead of
`Error: undefined`, and a tool that throws `undefined` or `null` produces an
error `ToolMessage` instead of failing the run.
