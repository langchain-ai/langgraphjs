---
"@langchain/langgraph": patch
---

A fork from a checkpoint before a DeltaChannel's first write no longer starts the channel's subscribers that never ran. The fork's snapshot gave the channel its first version, and a node subscribed to it ran on the empty value before the node that writes it.
