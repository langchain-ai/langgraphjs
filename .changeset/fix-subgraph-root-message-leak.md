---
"@langchain/langgraph-sdk": patch
---

fix(sdk): keep discovered subgraph messages out of root state

Messages scoped to a confirmed subgraph namespace no longer appear in
`rootStore`, while ordinary root-owned depth-one nodes continue to stream
normally.
