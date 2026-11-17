---
"@langchain/react": patch
---

Picks up the stream engine changes in the matching `@langchain/langgraph-sdk` release candidate: with `stateKeys: []`, runs no longer stream the whole state after every step, a thread opened during a run joins it a round trip sooner, and `/info` is read once per server instead of once per client.
