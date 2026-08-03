---
"@langchain/langgraph-api": patch
"@langchain/langgraph-cli": patch
"@langchain/langgraph-ui": patch
---

fix(langgraph-api): stop wiping graph recursionLimit with undefined

When a run omitted `config.recursion_limit`, the server still passed
`recursionLimit: undefined` into `streamEvents`. Pregel spreads that over the
graph's `withConfig` default, so agents fell back to langchain-core's 25.
Omit undefined keys so bound limits (and deepagents' 10000) stick.
