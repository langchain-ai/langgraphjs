---
"@langchain/langgraph": patch
---

feat(langgraph): add per-node `tracePolicy` input/output processors and `omitPayload`

Transform the payloads recorded on a node's own trace run while retaining its span and timing. Processors receive raw values and fall back to the original payload if they throw. Graph state, root runs, and child runs remain unchanged when processors do not mutate their arguments.

Matches Python's callback-level behavior: transforms also affect chain events and message streaming, so omitting outputs can suppress messages returned directly by nodes and omitting inputs can affect message deduplication.
