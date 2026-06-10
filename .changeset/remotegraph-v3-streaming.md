---
"@langchain/langgraph": patch
---

feat(remote): add RemoteGraph v3 streaming support

Expose the v3 `streamEvents` surface for `RemoteGraph` by adapting remote SDK thread streams to the local `GraphRunStream` shape.
