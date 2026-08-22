---
"@langchain/langgraph-api": patch
---

fix(langgraph-api): recover tool_call args from cumulative-args providers at end of call

A provider that re-sends the full args string per chunk instead of a
delta left `messages/partial` with a concatenation that never parses
(#2570). Once the model run ends, an args string that does not parse,
whose chunks form a growing prefix chain and whose last chunk parses on
its own, is replaced by that last chunk. Anything whose concatenation
parses is untouched.
