---
"@langchain/langgraph": patch
---

fix(langgraph): prefer configurable assistant and graph IDs for runtime server info

Update runtime `serverInfo` construction to read `assistant_id` and `graph_id` from
`config.configurable` first, with fallback to `config.metadata` for compatibility.
Also expands `execution_info` tests to cover configurable sourcing, precedence,
and metadata fallback behavior.
