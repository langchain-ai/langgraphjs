---
"@langchain/langgraph-api": patch
"@langchain/langgraph-cli": patch
"@langchain/langgraph-ui": patch
---

fix(langgraph-api): preserve additional_kwargs in protocol state normalizer

Forward non-empty `additional_kwargs` in values snapshots so server-authored
message metadata (e.g. committed attachment paths) reaches live subscribers.
Omit keys already lifted into first-class AI message fields (`tool_calls`,
`audio`, `tool_outputs`) to avoid duplicating normalized data on the wire.
