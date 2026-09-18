---
"@langchain/langgraph": patch
"@langchain/langgraph-sdk": patch
---

feat(langgraph): add `responseSchema` option to `interrupt()`

`interrupt(value, { responseSchema })` lets a graph declare the shape of the
value it expects on resume. A Zod schema validates the resume value and the
parsed result is what `interrupt()` returns; a raw JSON Schema object is passed
through as-is. The schema is surfaced on `Interrupt.response_schema` so clients
such as Studio can render a typed form instead of a free-form JSON editor.
Omitting the option keeps today's behavior.
