---
"@langchain/langgraph": patch
---

Forward LangChain custom callback events into V3 custom streams, preserving dispatch-time payloads and nested graph namespaces. Preserve callback metadata on V3 message starts and include `langgraph_message_source` to distinguish model streams from messages returned by graph nodes.
