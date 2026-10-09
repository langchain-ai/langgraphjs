---
"@langchain/langgraph": patch
---

A node served from the node cache now saves its writes like a node that ran. They were applied but never saved, so a `DeltaChannel` read back without them once the state was loaded again, under every durability. A cache hit is still streamed as cached and isn't written back to the cache.
